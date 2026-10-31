import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import {
    LU_RECORD_MAX_BYTES, LU_RECORD_MAX_ENCODED_CHARS, LU_SCORESERVER_SOURCE, crossCheckLuRecord, parseForwardedRecord,
    splitSignedLine, verifyLuRecord, type SigningKey,
} from '../utils/luRecordSignature.js';
import { SigningKeyService } from '../services/SigningKeyService.js';
import { WitnessEvidenceService } from '../services/WitnessEvidenceService.js';

/**
 * W72 (v2.205.0) — the Legends Unchained ScoreServer signature on a VPX score
 * record the cabinet Witness forwards (`record=` on GET /api/witness/score).
 *
 * Every key and record here is SYNTHETIC: a keypair generated in-test signs a
 * record built in-test, exactly the way the ScoreServer does (pure Ed25519 over
 * the line cut at the last `,"sig":`, plus `}`). No real play data, no real key.
 */

const USER = '223456789012345678';
const CABINET = 'ATG-UNIQUE-W72-CABINET';
const MINUTE = 60_000;

function keypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
    return { privateKey, publicB64: Buffer.from(jwk.x, 'base64url').toString('base64') };
}

/** Serialize the record without `sig`, sign that, then append `,"sig":"…"}` — the ScoreServer's shape. */
function signLine(record: Record<string, unknown>, privateKey: crypto.KeyObject): string {
    const body = JSON.stringify(record);
    const sig = crypto.sign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64');
    return body.slice(0, -1) + `,"sig":"${sig}"}`;
}

function iso(sec: number): string {
    return new Date(sec * 1000).toISOString();
}

function record(over: { score?: string; startedSec?: number; endedSec?: number; rom?: string } = {}) {
    const ended = over.endedSec ?? 1_756_429_360;
    const started = over.startedSec ?? ended - 15;
    return {
        game_duration: ended - started,
        machine_id: 'alp4k-01',
        reason: 'shutdown',
        rom: over.rom ?? 'test_rom',
        scores: [{ player: 'Player 1', score: over.score ?? '280', balls: [{ ball: 1, score: '280' }], timestamp: iso(ended) }],
        started: iso(started),
        timestamp: iso(ended),
        type: 'game_end',
    };
}

const keysOf = (...pairs: Array<{ publicB64: string }>): SigningKey[] =>
    pairs.map((p, i) => ({ id: i + 1, source: LU_SCORESERVER_SOURCE, publicKey: p.publicB64 }));

describe('luRecordSignature — the pure verifier', () => {
    const k = keypair();

    it('verifies a record signed with an active key, and parses it', () => {
        const line = signLine(record(), k.privateKey);
        const r = verifyLuRecord(line, keysOf(k));
        expect(r.status).toBe('verified');
        if (r.status === 'verified') {
            expect(r.source).toBe(LU_SCORESERVER_SOURCE);
            expect(r.record.type).toBe('game_end');
        }
        // Surrounding whitespace / the jsonl newline is trimmed before the cut.
        expect(verifyLuRecord(`  ${line}\r\n`, keysOf(k)).status).toBe('verified');
    });

    it('a single tampered byte fails', () => {
        const line = signLine(record({ score: '280' }), k.privateKey);
        const tampered = line.replace('"score":"280"', '"score":"980"');
        expect(tampered).not.toBe(line);
        expect(verifyLuRecord(tampered, keysOf(k))).toMatchObject({ status: 'failed' });
    });

    it('a record signed by a different key fails; any one of several active keys may verify', () => {
        const other = keypair();
        const line = signLine(record(), other.privateKey);
        expect(verifyLuRecord(line, keysOf(k))).toMatchObject({ status: 'failed' });
        expect(verifyLuRecord(line, keysOf(k, other))).toMatchObject({ status: 'verified', keyId: 2 });
    });

    it('no configured key, no sig, or a short sig is a failure, never a throw', () => {
        const line = signLine(record(), k.privateKey);
        expect(verifyLuRecord(line, [])).toEqual({ status: 'failed', reason: 'no signing key is configured' });
        expect(verifyLuRecord(JSON.stringify(record()), keysOf(k))).toMatchObject({ status: 'failed' });
        const short = JSON.stringify(record()).slice(0, -1) + ',"sig":"AAAA"}';
        expect(verifyLuRecord(short, keysOf(k))).toEqual({ status: 'failed', reason: 'the signature is not 64 bytes' });
        expect(verifyLuRecord('not json at all,"sig":"x"}', keysOf(k))).toMatchObject({ status: 'failed' });
        // A malformed registered key is skipped, not thrown on.
        expect(verifyLuRecord(line, [{ id: 9, source: LU_SCORESERVER_SOURCE, publicKey: 'AAAA' }])).toMatchObject({ status: 'failed' });
    });

    it('cuts at the LAST ,"sig": — a lookalike earlier in the line is not the cut point', () => {
        // In valid JSON a lookalike inside a string is escaped (rom = `x,"sig":"y`), and a
        // nested object may legitimately carry its own "sig" key: both sit before the real one.
        const rec = {
            ...record({ rom: 'x,"sig":"lookalike' }),
            meta: { a: 1, sig: 'nested-lookalike' },
        };
        const line = signLine(rec, k.privateKey);
        expect(line.indexOf(',"sig":')).toBeLessThan(line.lastIndexOf(',"sig":'));
        const parts = splitSignedLine(line)!;
        expect(parts.payload.toString('utf8')).toBe(JSON.stringify(rec));
        expect(parts.sig.length).toBe(64);
        expect(verifyLuRecord(line, keysOf(k)).status).toBe('verified');
    });

    it('the trim before the cut is whitespace/newline only: a BOM or no-break space stays in the signed bytes', () => {
        const body = JSON.stringify(record());
        const line = signLine(record(), k.privateKey);
        expect(verifyLuRecord(`\t ${line} \r\n`, keysOf(k)).status).toBe('verified');
        // The signer signed bytes without the BOM / NBSP, so keeping them (as the file had
        // them) must NOT verify - String.prototype.trim would have silently removed them.
        expect(splitSignedLine(`﻿${line}`)!.payload.toString('utf8')).toBe(`﻿${body}`);
        expect(verifyLuRecord(` ${line}`, keysOf(k)).status).toBe('failed');
    });

    it('parseForwardedRecord: base64 in, line out; malformed or oversize dropped', () => {
        const line = signLine(record(), k.privateKey);
        const b64 = Buffer.from(line, 'utf8').toString('base64');
        expect(parseForwardedRecord(b64)).toBe(line);
        // A `+` that arrived as a space (unescaped query string) is restored.
        expect(parseForwardedRecord(b64.replace(/\+/g, ' '))).toBe(line);
        // The url-safe alphabet decodes too.
        expect(parseForwardedRecord(Buffer.from(line, 'utf8').toString('base64url'))).toBe(line);
        for (const bad of [undefined, null, '', '   ', 42, ['a'], '!!!not base64!!!']) {
            expect(parseForwardedRecord(bad)).toBeNull();
        }
        // Size is judged on the ENCODED value: up to 8,192 characters is read...
        const atCap = Buffer.alloc(LU_RECORD_MAX_BYTES, 0x61).toString('base64');
        expect(atCap.length).toBe(LU_RECORD_MAX_ENCODED_CHARS);
        expect(parseForwardedRecord(atCap)).toBe('a'.repeat(LU_RECORD_MAX_BYTES));
        // ...one character more is "no record".
        expect(parseForwardedRecord(atCap + 'a')).toBeNull();
        expect(parseForwardedRecord(Buffer.alloc(LU_RECORD_MAX_BYTES + 3, 0x61).toString('base64'))).toBeNull();
        // A trailing CR/LF on the encoded value is tolerated.
        expect(parseForwardedRecord(`${b64}\r\n`)).toBe(line);
        // Not UTF-8 (a lone 0xff) is dropped.
        expect(parseForwardedRecord(Buffer.from([0x7b, 0xff, 0x7d]).toString('base64'))).toBeNull();
    });

    it('crossCheckLuRecord: score exact, end within 2 s, start NOT compared (a sitting record)', () => {
        const rec = record({ score: '8366650', startedSec: 1000, endedSec: 1300 });
        expect(crossCheckLuRecord(rec, { score: 8_366_650, endedTs: 1300 })).toEqual({ ok: true });
        // The record keeps milliseconds; the cabinet floors to seconds.
        expect(crossCheckLuRecord(rec, { score: 8_366_650, endedTs: 1298 })).toEqual({ ok: true });
        expect(crossCheckLuRecord(rec, { score: 8_366_651, endedTs: 1300 }).ok).toBe(false);
        expect(crossCheckLuRecord(rec, { score: 8_366_650, endedTs: 1303 }).ok).toBe(false);
        expect(crossCheckLuRecord({ type: 'game_end' }, { score: 1, endedTs: 1 }).ok).toBe(false);
        // Past 2^53 the comparison stays exact.
        const huge = record({ score: '90071992547409931', startedSec: 1000, endedSec: 1300 });
        expect(crossCheckLuRecord(huge, { score: 90071992547409931, endedTs: 1300 }).ok).toBe(false);
    });
});

describe('SigningKeyService + /api/admin/signing-keys', () => {
    let app: express.Express;
    const superToken = () => signToken({ role: 'super_admin', gameRoomIds: [], discordId: 'super-1', username: 'admin' });

    beforeEach(async () => {
        await setupTestDb();
        const db = await getDatabase();
        await db.run('DELETE FROM signing_keys');
        SigningKeyService.invalidate();
        app = express();
        app.use(express.json());
        const { default: adminRouter } = await import('../api/routes/admin.js');
        app.use('/api/admin', adminRouter);
    });

    it('migration 202 created the table and the evidence columns', async () => {
        const db = await getDatabase();
        const applied = await db.get(`SELECT name FROM schema_migrations WHERE name = '202_signing_keys_and_signed_evidence'`);
        expect(applied).toBeTruthy();
        const keyCols = (await db.all<Array<{ name: string }>>(`PRAGMA table_info(signing_keys)`)).map(c => c.name);
        expect(keyCols).toEqual(expect.arrayContaining(['id', 'source', 'algorithm', 'public_key', 'valid_from', 'valid_until', 'note', 'created_at']));
        const evCols = (await db.all<Array<{ name: string }>>(`PRAGMA table_info(witness_evidence)`)).map(c => c.name);
        expect(evCols).toEqual(expect.arrayContaining(['signed_by', 'signature_ok', 'signature_reason']));
    });

    it('add / list / retire, audited; a retired key verifies nothing', async () => {
        const k = keypair();
        const add = await request(app).post('/api/admin/signing-keys')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ public_key: k.publicB64, note: 'test key' });
        expect(add.status).toBe(201);
        expect(add.body.key).toMatchObject({ source: LU_SCORESERVER_SOURCE, publicKey: k.publicB64, active: true, validUntil: null });

        const dup = await request(app).post('/api/admin/signing-keys')
            .set('Authorization', `Bearer ${superToken()}`).send({ public_key: k.publicB64 });
        expect(dup.status).toBe(409);

        const bad = await request(app).post('/api/admin/signing-keys')
            .set('Authorization', `Bearer ${superToken()}`).send({ public_key: Buffer.alloc(33, 1).toString('base64') });
        expect(bad.status).toBe(400);

        const line = signLine(record(), k.privateKey);
        expect(verifyLuRecord(line, await SigningKeyService.activeKeys(LU_SCORESERVER_SOURCE)).status).toBe('verified');

        const list = await request(app).get('/api/admin/signing-keys').set('Authorization', `Bearer ${superToken()}`);
        expect(list.body.keys).toHaveLength(1);

        const retire = await request(app).post(`/api/admin/signing-keys/${add.body.key.id}/retire`)
            .set('Authorization', `Bearer ${superToken()}`).send({});
        expect(retire.status).toBe(200);
        expect(retire.body.key.active).toBe(false);
        expect(await SigningKeyService.activeKeys(LU_SCORESERVER_SOURCE)).toEqual([]);
        expect(verifyLuRecord(line, await SigningKeyService.activeKeys(LU_SCORESERVER_SOURCE)).status).toBe('failed');

        const again = await request(app).post(`/api/admin/signing-keys/${add.body.key.id}/retire`)
            .set('Authorization', `Bearer ${superToken()}`).send({});
        expect(again.status).toBe(409);
        const missing = await request(app).post('/api/admin/signing-keys/99999/retire')
            .set('Authorization', `Bearer ${superToken()}`).send({});
        expect(missing.status).toBe(404);

        const db = await getDatabase();
        const audits = await db.all<Array<{ action: string }>>(
            `SELECT action FROM audit_log WHERE target_type = 'signing_key' ORDER BY id`,
        );
        expect(audits.map(a => a.action)).toEqual(['signing_key.add', 'signing_key.retire']);
    });

    it('a key whose valid_from is ahead is not active yet; rotation = a second row', async () => {
        const a = keypair();
        const b = keypair();
        await SigningKeyService.add({ source: LU_SCORESERVER_SOURCE, publicKey: a.publicB64 });
        await SigningKeyService.add({
            source: LU_SCORESERVER_SOURCE, publicKey: b.publicB64,
            validFrom: new Date(Date.now() + 3600_000).toISOString(),
        });
        const now = await SigningKeyService.activeKeys(LU_SCORESERVER_SOURCE);
        expect(now.map(k => k.publicKey)).toEqual([a.publicB64]);
        const later = await SigningKeyService.activeKeys(LU_SCORESERVER_SOURCE, new Date(Date.now() + 7200_000));
        expect(later.map(k => k.publicKey)).toEqual([a.publicB64, b.publicB64]);
    });

    it('a non-super-admin is refused', async () => {
        const res = await request(app).get('/api/admin/signing-keys')
            .set('Authorization', `Bearer ${signToken({ role: 'room_admin', gameRoomIds: ['r'] })}`);
        expect(res.status).toBe(403);
    });
});

describe('W72 — the ingest cross-check (cabinet forwards record=)', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;
    let key: ReturnType<typeof keypair>;

    const playerToken = (discordId: string) =>
        signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });

    beforeEach(async () => {
        await setupTestDb();
        app = express();
        app.use(express.json());
        const { default: globalRouter } = await import('../api/routes/global.js');
        app.use('/api', globalRouter);
        const { default: integrityRouter } = await import('../api/routes/integrity.js');
        app.use('/api', integrityRouter);
        roomId = await createTestRoom(`w72-${crypto.randomUUID().slice(0, 8)}`);

        const db = await getDatabase();
        await db.run('DELETE FROM signing_keys');
        SigningKeyService.invalidate();
        key = keypair();
        await SigningKeyService.add({ source: LU_SCORESERVER_SOURCE, publicKey: key.publicB64, note: 'in-test key' });

        await db.run('DELETE FROM witness_devices WHERE atgames_unique_id = ?', CABINET);
        const codeRes = await request(app)
            .post('/api/me/witness/pairing-code')
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
        const pairRes = await request(app)
            .get('/api/witness/pair')
            .query({ code: codeRes.body.code, device: CABINET, username: 'Owner' });
        token = pairRes.body.token as string;
        expect(token).toBeTruthy();
    }, 30_000);

    async function roomGame(name = 'Bad Cats') {
        const db = await getDatabase();
        await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER, roomId);
        const tournamentId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
             VALUES (?, 'Signed Night', 'WG', 'pinball', '{}', 1, ?, 'rotation')`,
            tournamentId, roomId,
        );
        const gameId = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
             VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
            gameId, tournamentId, name, roomId, new Date(Date.now() - 60 * MINUTE).toISOString(),
        );
        const { WitnessService } = await import('../services/WitnessService.js');
        await WitnessService.setDeviceTarget(USER, CABINET, { roomId, tournamentId: null });
        return { tournamentId, gameId };
    }

    function play(score: number) {
        const ended = Math.floor(Date.now() / 1000);
        const started = ended - 300;
        return {
            query: {
                table: 'Bad Cats (Williams 1989)', rom: 'bcats_l5', slug: 'vpx-badcats',
                score, started, ended, dur: 300, reason: 'game_over',
            },
            started, ended,
        };
    }

    const forward = (line: string) => Buffer.from(line, 'utf8').toString('base64');
    const send = (q: Record<string, unknown>) =>
        request(app).get('/api/witness/score').query({ device: CABINET, token, ...q });

    async function trailFor(gameId: string) {
        const db = await getDatabase();
        return db.all<Array<{ outcome: string; score_history_id: number | null; signature_ok: number | null; signed_by: string | null; signature_reason: string | null; reasons: string }>>(
            `SELECT outcome, score_history_id, signature_ok, signed_by, signature_reason, reasons
               FROM witness_evidence WHERE canonical_user_id = ? AND (game_id = ? OR game_id IS NULL) ORDER BY id`,
            USER, gameId,
        );
    }

    it('a signed record that agrees: ingested, signature_ok = 1, badged on the integrity read', async () => {
        const { gameId, tournamentId } = await roomGame();
        const p = play(8_366_650);
        const line = signLine(record({ score: '8366650', startedSec: p.started, endedSec: p.ended }), key.privateKey);
        const res = await send({ ...p.query, record: forward(line) });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });

        const trail = await trailFor(gameId);
        expect(trail).toHaveLength(1);
        expect(trail[0]).toMatchObject({ outcome: 'ingested', signature_ok: 1, signed_by: LU_SCORESERVER_SOURCE, signature_reason: null });

        const pub = await request(app).get(`/api/rooms/${roomId}/tournaments/${tournamentId}/integrity`);
        expect(pub.body.signed).toEqual({ [String(trail[0].score_history_id)]: { by: LU_SCORESERVER_SOURCE } });
        // Additive: a cabinet still gets no verdict.
        expect(pub.body.verdicts).toEqual({});

        const list = await WitnessEvidenceService.listForTournament(tournamentId);
        expect(list[0]).toMatchObject({ signatureOk: true, signedBy: LU_SCORESERVER_SOURCE });
        const plays = await WitnessEvidenceService.recentPlaysForUser(USER);
        expect(plays[0]).toMatchObject({ signedBy: LU_SCORESERVER_SOURCE });
    });

    it('the LAST game of a split sitting is badged even though the record\'s start is the sitting\'s', async () => {
        const { gameId } = await roomGame();
        const p = play(7_000_000);
        // The sitting began 20 minutes before this (last) game did.
        const line = signLine(record({ score: '7000000', startedSec: p.started - 1200, endedSec: p.ended }), key.privateKey);
        const res = await send({ ...p.query, record: forward(line) });
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });
        const trail = await trailFor(gameId);
        expect(trail[0]).toMatchObject({ signature_ok: 1, signed_by: LU_SCORESERVER_SOURCE });
    });

    it('a genuine signature over ANOTHER game of the sitting: the score lands unbadged, never dropped', async () => {
        const { gameId, tournamentId } = await roomGame();
        // The cabinet split one sitting into two games and forwards the SAME record
        // (whose top-level score and end are the last game's) with each of them.
        const last = play(8_000_000);
        const earlierEnded = last.ended - 400;
        const sitting = signLine(record({ score: '8000000', startedSec: earlierEnded - 300, endedSec: last.ended }), key.privateKey);

        const early = await send({
            ...last.query, score: 2_500_000, started: earlierEnded - 300, ended: earlierEnded,
            record: forward(sitting),
        });
        expect(early.body).toMatchObject({ ok: true, status: 'ingested' });
        const final = await send({ ...last.query, record: forward(sitting) });
        expect(final.body).toMatchObject({ ok: true, status: 'ingested' });

        const db = await getDatabase();
        const rows = await db.all<Array<{ id: number; score: number }>>(
            `SELECT id, score FROM score_history WHERE game_id = ? AND source = 'vpx' ORDER BY score`, gameId,
        );
        expect(rows.map(r => r.score)).toEqual([2_500_000, 8_000_000]);

        const trail = await trailFor(gameId);
        expect(trail).toHaveLength(2);
        expect(trail[0]).toMatchObject({
            outcome: 'ingested', score_history_id: rows[0].id,
            signature_ok: 0, signed_by: LU_SCORESERVER_SOURCE, signature_reason: 'signed_record_other_game',
        });
        expect(trail[1]).toMatchObject({ outcome: 'ingested', signature_ok: 1, signed_by: LU_SCORESERVER_SOURCE });
        // Only the game the record IS gets the badge.
        expect(await WitnessEvidenceService.signedMap(tournamentId)).toEqual({ [String(rows[1].id)]: { by: LU_SCORESERVER_SOURCE } });

        const list = await WitnessEvidenceService.listForTournament(tournamentId);
        expect(list.find(r => r.score === 2_500_000)).toMatchObject({
            signatureOk: false, signedBy: LU_SCORESERVER_SOURCE, signatureReason: 'signed_record_other_game',
        });
        const plays = await WitnessEvidenceService.recentPlaysForUser(USER);
        expect(plays.find(p => p.score === 2_500_000)).toMatchObject({ signedBy: null, signedOtherGame: true });
        expect(plays.find(p => p.score === 8_000_000)).toMatchObject({ signedBy: LU_SCORESERVER_SOURCE, signedOtherGame: false });
    });

    it('a genuine signature on a record that is not this score at all still never drops it', async () => {
        const { gameId } = await roomGame();
        const p = play(9_999_999);
        const line = signLine(record({ score: '280', startedSec: p.started, endedSec: p.ended }), key.privateKey);
        const res = await send({ ...p.query, record: forward(line) });
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });
        const trail = await trailFor(gameId);
        expect(trail[0]).toMatchObject({ outcome: 'ingested', signature_ok: 0, signature_reason: 'signed_record_other_game' });
    });

    it('a signature that FAILS: the score lands as unsigned, signature_ok = 0 with the reason', async () => {
        const { gameId, tournamentId } = await roomGame();
        const p = play(4_200_000);
        const stranger = keypair();
        const line = signLine(record({ score: '4200000', startedSec: p.started, endedSec: p.ended }), stranger.privateKey);
        const res = await send({ ...p.query, record: forward(line) });
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });

        const trail = await trailFor(gameId);
        expect(trail[0]).toMatchObject({ outcome: 'ingested', signature_ok: 0, signed_by: null });
        expect(trail[0].signature_reason).toMatch(/does not verify/);
        expect(await WitnessEvidenceService.signedMap(tournamentId)).toEqual({});
    });

    it('no record: today\'s path, signature_ok NULL; a malformed record is dropped like no record', async () => {
        const { gameId } = await roomGame();
        const p = play(1_000_000);
        const res = await send(p.query);
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });
        const p2 = play(2_000_000);
        const res2 = await send({ ...p2.query, record: '%%% not base64 %%%' });
        expect(res2.status).toBe(200);
        expect(res2.body).toMatchObject({ ok: true, status: 'ingested' });

        // Over 8,192 encoded characters is "no record" too - not a failed signature -
        // even when the record inside is genuine.
        const p3 = play(3_500_000);
        const padded = { ...record({ score: '3500000', startedSec: p3.started, endedSec: p3.ended }), pad: 'x'.repeat(7000) };
        const big = forward(signLine(padded, key.privateKey));
        expect(big.length).toBeGreaterThan(8192);
        const res3 = await send({ ...p3.query, record: big });
        expect(res3.status).toBe(200);
        expect(res3.body).toMatchObject({ ok: true, status: 'ingested' });

        const trail = await trailFor(gameId);
        expect(trail.map(t => t.signature_ok)).toEqual([null, null, null]);
    });

    it('a retired key: the record no longer verifies and the score lands unsigned', async () => {
        const { gameId } = await roomGame();
        const [only] = await SigningKeyService.list();
        await SigningKeyService.retire(only!.id);
        const p = play(3_000_000);
        const line = signLine(record({ score: '3000000', startedSec: p.started, endedSec: p.ended }), key.privateKey);
        const res = await send({ ...p.query, record: forward(line) });
        expect(res.body).toMatchObject({ status: 'ingested' });
        const trail = await trailFor(gameId);
        expect(trail[0]).toMatchObject({ signature_ok: 0, signature_reason: 'no signing key is configured' });
    });
});
