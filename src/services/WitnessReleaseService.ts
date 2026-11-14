import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../database/database.js';
import { logInfo, logWarn } from '../utils/logger.js';
import { compareVersions, isReleaseVersion } from '../utils/witnessVersion.js';
import { isElf, verifyReleaseSignature, WITNESS_RELEASE_PUBLIC_KEY_HEX } from '../utils/witnessReleaseSignature.js';

/**
 * W100 (v2.245.0, ADR 0040) - signed self-update for Arcaid Witness cabinets.
 *
 * A super-admin uploads a cabinet build (the ELF and its Ed25519 signature,
 * made on the owner's PC by `npm run witness-release -- sign`). The server
 * verifies the signature with the baked public key before it stores anything,
 * so a build every cabinet would reject is refused at the door. A new release
 * is a `draft`; moving it to `beta` and then `stable` is the staged rollout.
 *
 * THE OFFER RULE (`offeredRelease`, pure) is the one answer to "which build
 * should this device install" and is used by the heartbeat's `update` field,
 * `/witness/app/release`, `/witness/app/download` and the player's devices
 * list, so the four can never disagree: the HIGHEST release whose channel is
 * `stable` (or `beta` when the device has `test_builds` on) and that is
 * numerically newer than the version the device reports - and only for a
 * cabinet (`atgames`) with `auto_update` on that reported a version. `draft`
 * is offered to nobody.
 *
 * Files: `data/witness-releases/<version>/arcaid-witness.elf`. `<version>` is
 * always checked against the strict dotted-numeric triple first
 * (`isReleaseVersion`), so no request value can name another path.
 */

export type ReleaseChannel = 'draft' | 'beta' | 'stable';
export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ['draft', 'beta', 'stable'];
export function isReleaseChannel(value: unknown): value is ReleaseChannel {
    return typeof value === 'string' && (RELEASE_CHANNELS as readonly string[]).includes(value);
}

/** The largest ELF a release may carry (the contract's 16 MiB). */
export const RELEASE_MAX_BYTES = 16 * 1024 * 1024;
/** Release notes are a human paragraph or two; anything longer is cut. */
export const RELEASE_NOTES_MAX_CHARS = 4000;
const ELF_NAME = 'arcaid-witness.elf';

/** The super-admin wire shape (contract §3). */
export interface Release {
    version: string;
    channel: ReleaseChannel;
    size: number;
    sha256: string;
    notes: string | null;
    uploadedAt: string;
}

/** What the device routes need: the wire release plus its signature. */
export interface OfferedRelease extends Release {
    sig: string;
}

interface ReleaseRow {
    version: string;
    channel: string;
    size: number;
    sha256: string;
    sig: string;
    notes: string | null;
    uploaded_by: string | null;
    uploaded_at: string;
}

export class WitnessReleaseError extends Error {
    readonly code: 'VERSION_INVALID' | 'VERSION_EXISTS' | 'NOT_ELF' | 'SIGNATURE_INVALID' | 'TOO_LARGE'
        | 'CHANNEL_INVALID' | 'NOTES_INVALID';
    constructor(code: WitnessReleaseError['code'], message: string) {
        super(message);
        this.name = 'WitnessReleaseError';
        this.code = code;
    }
}

/** The device facts the offer rule reads. */
export interface OfferDevice {
    /** `witness_devices.device_type` as stored: only `atgames` (a cabinet) is ever offered a build. */
    deviceType: string | null;
    autoUpdate: boolean;
    testBuilds: boolean;
    /** The build the device reports running; null / empty = it never said, so nothing is offered. */
    reportedVersion: string | null;
}

/**
 * THE OFFER RULE. Pure: the highest eligible release newer than what the
 * device runs, or null. Eligible = `stable`, plus `beta` when the device takes
 * test builds; never `draft`. Only a cabinet with automatic updates on that
 * reported a version is offered anything.
 */
export function offeredRelease(device: OfferDevice, releases: ReadonlyArray<{ version: string; channel: string }>): string | null {
    if (device.deviceType !== 'atgames') return null;
    if (!device.autoUpdate) return null;
    const reported = (device.reportedVersion ?? '').trim();
    if (!reported) return null;
    let best: string | null = null;
    for (const r of releases) {
        const eligible = r.channel === 'stable' || (r.channel === 'beta' && device.testBuilds);
        if (!eligible || !isReleaseVersion(r.version)) continue;
        if (compareVersions(r.version, reported) <= 0) continue;
        if (best === null || compareVersions(r.version, best) > 0) best = r.version;
    }
    return best;
}

function sqliteToIso(value: string): string {
    const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

function toWire(row: ReleaseRow): Release {
    return {
        version: row.version,
        channel: isReleaseChannel(row.channel) ? row.channel : 'draft',
        size: row.size,
        sha256: row.sha256,
        notes: row.notes,
        uploadedAt: sqliteToIso(row.uploaded_at),
    };
}

/** `notes` from a request: undefined = leave as is, null/blank = clear, else trimmed and capped. */
function normalizeNotes(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') throw new WitnessReleaseError('NOTES_INVALID', 'Notes must be text');
    const t = value.trim();
    return t ? t.slice(0, RELEASE_NOTES_MAX_CHARS) : null;
}

export class WitnessReleaseService {
    private static root = path.join(process.cwd(), 'data', 'witness-releases');
    private static publicKeyHex = WITNESS_RELEASE_PUBLIC_KEY_HEX;

    /** Tests point the release directory at a temp dir (null restores the default). */
    static setRootForTests(root: string | null): void {
        WitnessReleaseService.root = root ?? path.join(process.cwd(), 'data', 'witness-releases');
    }

    /**
     * Tests sign with a throwaway key (the real private key never leaves the
     * owner's PC). Refused outside vitest, so production always verifies
     * against the baked key.
     */
    static setPublicKeyForTests(hex: string | null): void {
        if (!process.env.VITEST) throw new Error('setPublicKeyForTests is for tests only');
        WitnessReleaseService.publicKeyHex = hex ?? WITNESS_RELEASE_PUBLIC_KEY_HEX;
    }

    private static dirFor(version: string): string {
        if (!isReleaseVersion(version)) throw new WitnessReleaseError('VERSION_INVALID', 'Invalid release version');
        return path.join(WitnessReleaseService.root, version);
    }

    private static elfPath(version: string): string {
        return path.join(WitnessReleaseService.dirFor(version), ELF_NAME);
    }

    /**
     * Store a new release as a `draft`. Refusals, in order: VERSION_INVALID
     * (not a dotted-numeric triple), TOO_LARGE (> 16 MiB), NOT_ELF (no
     * `\x7fELF`), SIGNATURE_INVALID (does not verify with the baked public
     * key over `"AW1 <version>\n"` + the ELF), VERSION_EXISTS.
     */
    static async store(input: { version: unknown; elf: Buffer; sig: unknown; notes?: unknown; uploadedBy: string | null }): Promise<Release> {
        const version = typeof input.version === 'string' ? input.version.trim() : '';
        if (!isReleaseVersion(version)) {
            throw new WitnessReleaseError('VERSION_INVALID', 'The version must be a dotted-numeric triple such as 1.1.0');
        }
        if (input.elf.length > RELEASE_MAX_BYTES) {
            throw new WitnessReleaseError('TOO_LARGE', 'The build is larger than 16 MiB');
        }
        if (!isElf(input.elf)) throw new WitnessReleaseError('NOT_ELF', 'The file is not an ELF executable');
        const sig = typeof input.sig === 'string' ? input.sig.trim() : '';
        if (!verifyReleaseSignature(version, input.elf, sig, WitnessReleaseService.publicKeyHex)) {
            throw new WitnessReleaseError('SIGNATURE_INVALID', 'The signature does not verify for this file and version');
        }
        const notes = normalizeNotes(input.notes) ?? null;

        const db = await getDatabase();
        const exists = await db.get(`SELECT 1 FROM witness_app_releases WHERE version = ?`, version);
        if (exists) throw new WitnessReleaseError('VERSION_EXISTS', `Release ${version} already exists`);

        // The file goes in under a temporary name and is renamed into place
        // only after the row is in, so a lost race never overwrites another
        // upload's ELF. A draft is offered to nobody, so the moment between
        // the row and the rename serves no device.
        const dir = WitnessReleaseService.dirFor(version);
        await fs.promises.mkdir(dir, { recursive: true });
        const final = path.join(dir, ELF_NAME);
        const part = path.join(dir, `${ELF_NAME}.${randomBytes(6).toString('hex')}.part`);
        await fs.promises.writeFile(part, input.elf);
        const sha256 = createHash('sha256').update(input.elf).digest('hex');
        try {
            await db.run(
                `INSERT INTO witness_app_releases (version, channel, size, sha256, sig, notes, uploaded_by)
                 VALUES (?, 'draft', ?, ?, ?, ?, ?)`,
                version, input.elf.length, sha256, sig, notes, input.uploadedBy,
            );
        } catch (err) {
            await fs.promises.rm(part, { force: true });
            const raced = await db.get(`SELECT 1 FROM witness_app_releases WHERE version = ?`, version);
            if (raced) throw new WitnessReleaseError('VERSION_EXISTS', `Release ${version} already exists`);
            throw err;
        }
        try {
            await fs.promises.rename(part, final);
        } catch (err) {
            await db.run(`DELETE FROM witness_app_releases WHERE version = ?`, version);
            await fs.promises.rm(part, { force: true });
            throw err;
        }
        logInfo(`Witness release ${version} stored as draft (${input.elf.length} bytes, sha256 ${sha256})`);
        return (await WitnessReleaseService.get(version))!;
    }

    static async get(version: string): Promise<Release | null> {
        if (!isReleaseVersion(version)) return null;
        const db = await getDatabase();
        const row = await db.get<ReleaseRow>(`SELECT * FROM witness_app_releases WHERE version = ?`, version);
        return row ? toWire(row) : null;
    }

    /** Every release, newest version first. */
    static async list(): Promise<Release[]> {
        const db = await getDatabase();
        const rows = await db.all<ReleaseRow[]>(`SELECT * FROM witness_app_releases`);
        return rows.sort((a, b) => compareVersions(b.version, a.version)).map(toWire);
    }

    /** Change a release's channel and/or notes. Null = no such release. */
    static async patch(version: string, input: { channel?: unknown; notes?: unknown }): Promise<{ release: Release; previousChannel: ReleaseChannel } | null> {
        if (!isReleaseVersion(version)) return null;
        if (input.channel !== undefined && !isReleaseChannel(input.channel)) {
            throw new WitnessReleaseError('CHANNEL_INVALID', `Channel must be one of ${RELEASE_CHANNELS.join(', ')}`);
        }
        const notes = normalizeNotes(input.notes);
        const db = await getDatabase();
        const row = await db.get<ReleaseRow>(`SELECT * FROM witness_app_releases WHERE version = ?`, version);
        if (!row) return null;
        const previousChannel = isReleaseChannel(row.channel) ? row.channel : 'draft';
        const channel = (input.channel as ReleaseChannel | undefined) ?? previousChannel;
        await db.run(
            `UPDATE witness_app_releases SET channel = ?, notes = ? WHERE version = ?`,
            channel, notes === undefined ? row.notes : notes, version,
        );
        return { release: (await WitnessReleaseService.get(version))!, previousChannel };
    }

    /** Delete a release: row, then its directory. Null = no such release; else the deleted release. */
    static async remove(version: string): Promise<Release | null> {
        if (!isReleaseVersion(version)) return null;
        const release = await WitnessReleaseService.get(version);
        if (!release) return null;
        const db = await getDatabase();
        await db.run(`DELETE FROM witness_app_releases WHERE version = ?`, version);
        try {
            await fs.promises.rm(WitnessReleaseService.dirFor(version), { recursive: true, force: true });
        } catch (err) {
            logWarn(`Witness release ${version}: row deleted, files not removed (${(err as Error)?.message ?? String(err)})`);
        }
        logInfo(`Witness release ${version} deleted`);
        return release;
    }

    /** Unrevoked CABINET devices by the build they last reported (`''` = never reported), newest first. */
    static async devicesByVersion(): Promise<Array<{ version: string; count: number }>> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ version: string; count: number }>>(
            `SELECT COALESCE(app_version, '') AS version, COUNT(*) AS count
               FROM witness_devices
              WHERE revoked_at IS NULL AND device_type = 'atgames'
              GROUP BY COALESCE(app_version, '')`,
        );
        return rows
            .map(r => ({ version: r.version, count: Number(r.count) }))
            .sort((a, b) => (a.version === '' ? 1 : b.version === '' ? -1 : compareVersions(b.version, a.version)));
    }

    /** The releases the offer rule can ever pick (beta + stable). */
    static async offerableReleases(): Promise<Array<{ version: string; channel: string }>> {
        const db = await getDatabase();
        return db.all<Array<{ version: string; channel: string }>>(
            `SELECT version, channel FROM witness_app_releases WHERE channel IN ('beta', 'stable')`,
        );
    }

    /**
     * The offer rule for one paired device, by id. `reportedVersion` is the
     * build the device says it runs (the heartbeat's own `v`); pass
     * `undefined` to use the build it last reported (`app_version`). Null for
     * an unknown or unpaired device.
     */
    static async offeredFor(deviceId: string, reportedVersion: string | null | undefined): Promise<string | null> {
        const db = await getDatabase();
        const device = await db.get<{ device_type: string | null; auto_update: number; test_builds: number; app_version: string | null }>(
            `SELECT device_type, auto_update, test_builds, app_version FROM witness_devices
              WHERE atgames_unique_id = ? AND revoked_at IS NULL`,
            deviceId,
        );
        if (!device) return null;
        return offeredRelease({
            deviceType: device.device_type,
            autoUpdate: device.auto_update !== 0,
            testBuilds: device.test_builds === 1,
            reportedVersion: reportedVersion === undefined ? device.app_version : reportedVersion,
        }, await WitnessReleaseService.offerableReleases());
    }

    /**
     * The device routes: the release `version` when it is EXACTLY what the
     * offer rule gives this device right now (judged on the build it last
     * reported), else null. Demoting a release to `draft` therefore stops its
     * downloads at once.
     */
    static async releaseOfferedTo(deviceId: string, version: unknown): Promise<OfferedRelease | null> {
        if (!isReleaseVersion(version)) return null;
        const offered = await WitnessReleaseService.offeredFor(deviceId, undefined);
        if (offered !== version) return null;
        const db = await getDatabase();
        const row = await db.get<ReleaseRow>(`SELECT * FROM witness_app_releases WHERE version = ?`, version);
        return row ? { ...toWire(row), sig: row.sig } : null;
    }

    /** The release's ELF as a read stream with its size, or null when the file is missing or not the stored size. */
    static async openElf(release: { version: string; size: number }): Promise<{ stream: fs.ReadStream; size: number } | null> {
        if (!isReleaseVersion(release.version)) return null;
        const file = WitnessReleaseService.elfPath(release.version);
        let size: number;
        try {
            const st = await fs.promises.stat(file);
            if (!st.isFile()) return null;
            size = st.size;
        } catch {
            return null;
        }
        if (size !== release.size) {
            logWarn(`Witness release ${release.version}: file is ${size} bytes, the row says ${release.size}; not served`);
            return null;
        }
        return { stream: fs.createReadStream(file), size };
    }
}
