import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { getDatabase } from '../database/database.js';
import { logWarn } from '../utils/logger.js';
import { compareVersions, isReleaseVersion } from '../utils/witnessVersion.js';
import { WitnessReleaseService, type Release } from './WitnessReleaseService.js';

/**
 * W102 (v2.247.0, ADR 0040 addendum) - the cabinet install kit.
 *
 * A first install (and the recovery from a build that cannot start) is a
 * manual copy onto the cabinet's USB stick: the app ELF plus the tile's art,
 * its description XML and the controller map. The player downloads all four
 * as one zip from Account Settings instead of collecting them by hand.
 *
 * - The ELF is ALWAYS the highest `stable` release (`compareVersions`), read
 *   through `WitnessReleaseService.openElf`; never `beta` or `draft`, whatever
 *   the player's own test-builds switch says.
 * - The three static files are committed at repo root `witness-kit/`
 *   (byte-exact, `-text` in `.gitattributes`) and copied into the image by the
 *   Dockerfile's production stage. Resolved from `process.cwd()`.
 * - The zip is written by hand (no dependency): one top folder
 *   `arcaid-witness/`, every entry deflated, the ELF marked 0755. The last
 *   built zip is kept in memory, keyed on the release's version and SHA-256.
 */

export const KIT_FOLDER = 'arcaid-witness';
export const KIT_ELF_NAME = 'arcaid-witness.elf';
export const KIT_STATIC_FILES = ['arcaid-witness.png', 'arcaid-witness.xml', 'external_controller_db.txt'] as const;

/** Unix modes for the zip's external attributes (regular file + permissions). */
const MODE_EXECUTABLE = 0o100755;
const MODE_FILE = 0o100644;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

/** CRC-32 (IEEE 802.3), as the zip format stores it. Node 20 has no `zlib.crc32`. */
export function crc32(data: Buffer): number {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xFF]! ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** MS-DOS date and time fields (UTC; the format has no zone). */
function dosDateTime(at: Date): { time: number; date: number } {
    const d = Number.isFinite(at.getTime()) && at.getUTCFullYear() >= 1980 ? at : new Date(Date.UTC(1980, 0, 1));
    return {
        time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
        date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    };
}

export interface ZipEntry { name: string; data: Buffer; mode: number }

/** A plain zip (no zip64, no data descriptors, every entry deflated). */
export function buildZip(entries: ZipEntry[], modifiedAt: Date): Buffer {
    const { time, date } = dosDateTime(modifiedAt);
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const compressed = zlib.deflateRawSync(entry.data, { level: 9 });
        const crc = crc32(entry.data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(8, 8); // method: deflate
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28); // extra length
        locals.push(local, name, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0 (so the mode below is read)
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30); // extra length
        central.writeUInt16LE(0, 32); // comment length
        central.writeUInt16LE(0, 34); // disk number
        central.writeUInt16LE(0, 36); // internal attributes
        central.writeUInt32LE(((entry.mode & 0xFFFF) << 16) >>> 0, 38); // external: Unix mode in the high half
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);

        offset += local.length + name.length + compressed.length;
    }
    const centralDir = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDir.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, centralDir, end]);
}

export class WitnessKitService {
    private static root = path.join(process.cwd(), 'witness-kit');
    private static cache: { key: string; zip: Buffer } | null = null;

    /** Tests point the static-file folder at a temp dir (null restores the default). Clears the cache. */
    static setRootForTests(root: string | null): void {
        WitnessKitService.root = root ?? path.join(process.cwd(), 'witness-kit');
        WitnessKitService.cache = null;
    }

    /** The kit's release: the highest `stable` release, or null. Never `beta` or `draft`. */
    static async kitRelease(): Promise<Release | null> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ version: string }>>(
            `SELECT version FROM witness_app_releases WHERE channel = 'stable'`,
        );
        let best: string | null = null;
        for (const r of rows) {
            if (!isReleaseVersion(r.version)) continue;
            if (best === null || compareVersions(r.version, best) > 0) best = r.version;
        }
        return best ? WitnessReleaseService.get(best) : null;
    }

    /**
     * The kit zip for a `stable` release, or null (no such release, not
     * stable, its ELF missing or not the stored bytes, or a static file
     * missing). Cached in memory per version + SHA-256.
     */
    static async buildKit(version: string): Promise<Buffer | null> {
        const release = await WitnessReleaseService.get(version);
        if (!release || release.channel !== 'stable') return null;
        const key = `${release.version}:${release.sha256}`;
        if (WitnessKitService.cache?.key === key) return WitnessKitService.cache.zip;

        const elf = await WitnessKitService.readElf(release);
        if (!elf) return null;
        if (createHash('sha256').update(elf).digest('hex') !== release.sha256) {
            logWarn(`Witness kit ${release.version}: the ELF does not match its stored SHA-256; no kit`);
            return null;
        }
        const entries: ZipEntry[] = [{ name: `${KIT_FOLDER}/${KIT_ELF_NAME}`, data: elf, mode: MODE_EXECUTABLE }];
        for (const file of KIT_STATIC_FILES) {
            let data: Buffer;
            try {
                data = await fs.promises.readFile(path.join(WitnessKitService.root, file));
            } catch {
                logWarn(`Witness kit: static file ${file} is missing; no kit`);
                return null;
            }
            entries.push({ name: `${KIT_FOLDER}/${file}`, data, mode: MODE_FILE });
        }
        const zip = buildZip(entries, new Date(release.uploadedAt));
        WitnessKitService.cache = { key, zip };
        return zip;
    }

    /** The current kit (highest stable release) with its zip, or null when there is none to give. */
    static async current(): Promise<{ release: Release; zip: Buffer } | null> {
        const release = await WitnessKitService.kitRelease();
        if (!release) return null;
        const zip = await WitnessKitService.buildKit(release.version);
        return zip ? { release, zip } : null;
    }

    /** The release ELF's bytes, through the release service's own reader. */
    private static async readElf(release: Release): Promise<Buffer | null> {
        const file = await WitnessReleaseService.openElf(release);
        if (!file) return null;
        const chunks: Buffer[] = [];
        try {
            for await (const chunk of file.stream) chunks.push(chunk as Buffer);
        } catch (err) {
            logWarn(`Witness kit ${release.version}: reading the ELF failed (${(err as NodeJS.ErrnoException)?.code ?? 'error'})`);
            return null;
        }
        return Buffer.concat(chunks);
    }
}
