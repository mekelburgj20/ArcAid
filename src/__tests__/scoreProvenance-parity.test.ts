import { describe, it, expect } from 'vitest';
import * as be from '../utils/scoreProvenance.js';
// Deliberately reaches across the BE/FE boundary: this test exists precisely to
// prove the two copies have not drifted. Vitest resolves the .ts directly; the
// module is dependency-free so nothing browser-specific is pulled in.
import * as fe from '../../admin-ui/src/lib/scoreProvenance';

/**
 * BE ↔ FE taxonomy parity (ADR 0016, contract §1 — a hard requirement).
 *
 * The predecessor mirror pair (`src/utils/platformMapping.ts` ↔
 * `admin-ui/src/lib/platforms.ts`) had NO parity test and silently rotted to 22
 * of 53 aliases: the FE quietly failed to fold ids the BE folded, and nothing
 * caught it for releases. This test is the thing that would have.
 *
 * It deep-compares every piece of authored data, not just the keys — a label
 * typo or a compat-list edit on one side alone fails here.
 */
describe('score provenance — BE/FE taxonomy parity', () => {
    it('exports the same engine ids, labels and categories', () => {
        expect(Object.keys(fe.CANONICAL_ENGINES).sort()).toEqual(Object.keys(be.CANONICAL_ENGINES).sort());
        expect(fe.CANONICAL_ENGINES).toEqual(be.CANONICAL_ENGINES);
    });

    it('exports the same device ids and labels', () => {
        expect(Object.keys(fe.CANONICAL_DEVICES).sort()).toEqual(Object.keys(be.CANONICAL_DEVICES).sort());
        expect(fe.CANONICAL_DEVICES).toEqual(be.CANONICAL_DEVICES);
    });

    it('exports the same engine→device compatibility map', () => {
        expect(fe.ENGINE_DEVICE_COMPAT).toEqual(be.ENGINE_DEVICE_COMPAT);
    });

    it('exports the same legacy platform map', () => {
        expect(Object.keys(fe.LEGACY_PLATFORM_MAP).sort()).toEqual(Object.keys(be.LEGACY_PLATFORM_MAP).sort());
        expect(fe.LEGACY_PLATFORM_MAP).toEqual(be.LEGACY_PLATFORM_MAP);
    });

    it('exports the same derivation tables and AtGames variants', () => {
        expect(fe.ENGINE_PRIMARY_PLATFORM).toEqual(be.ENGINE_PRIMARY_PLATFORM);
        expect(fe.PROVENANCE_PLATFORM_OVERRIDES).toEqual(be.PROVENANCE_PLATFORM_OVERRIDES);
        expect(fe.DEVICE_LEGACY_PLATFORM).toEqual(be.DEVICE_LEGACY_PLATFORM);
        expect(fe.ATGAMES_DEVICE_VARIANTS).toEqual(be.ATGAMES_DEVICE_VARIANTS);
        expect(fe.UNKNOWN).toBe(be.UNKNOWN);
    });

    it('behaves identically across every legacy token and engine/device pair', () => {
        // Functions, not just data: a divergent implementation with identical
        // tables would still break the picker↔validator agreement.
        for (const token of Object.keys(be.LEGACY_PLATFORM_MAP)) {
            expect(fe.mapLegacyPlatform(token)).toEqual(be.mapLegacyPlatform(token));
            expect(fe.mapLegacyPlatform(token.toUpperCase())).toEqual(be.mapLegacyPlatform(token.toUpperCase()));
        }
        for (const engine of [...Object.keys(be.CANONICAL_ENGINES), be.UNKNOWN]) {
            expect(fe.devicesForEngine(engine)).toEqual(be.devicesForEngine(engine));
            expect(fe.getEngineDisplay(engine)).toBe(be.getEngineDisplay(engine));
            for (const device of [...Object.keys(be.CANONICAL_DEVICES), be.UNKNOWN]) {
                expect(fe.isEngineDeviceCompatible(engine, device))
                    .toBe(be.isEngineDeviceCompatible(engine, device));
                expect(fe.deriveLegacyPlatform(engine, device))
                    .toBe(be.deriveLegacyPlatform(engine, device));
            }
        }
        for (const device of Object.keys(be.CANONICAL_DEVICES)) {
            expect(fe.getDeviceDisplay(device)).toBe(be.getDeviceDisplay(device));
        }
    });

    it('every engine in the compat map is a canonical engine, and vice versa', () => {
        expect(Object.keys(be.ENGINE_DEVICE_COMPAT).sort()).toEqual(Object.keys(be.CANONICAL_ENGINES).sort());
        for (const [engine, devices] of Object.entries(be.ENGINE_DEVICE_COMPAT)) {
            expect(devices.length, `${engine} has no compatible devices`).toBeGreaterThan(0);
            for (const d of devices) {
                expect(be.isCanonicalDevice(d), `${engine} → unknown device "${d}"`).toBe(true);
            }
        }
    });

    it('every legacy mapping targets a canonical engine/device or the unknown sentinel', () => {
        for (const [token, prov] of Object.entries(be.LEGACY_PLATFORM_MAP)) {
            const engineOk = prov.engine === be.UNKNOWN || be.isCanonicalEngine(prov.engine);
            const deviceOk = prov.device === be.UNKNOWN || be.isCanonicalDevice(prov.device);
            expect(engineOk, `${token} → bad engine "${prov.engine}"`).toBe(true);
            expect(deviceOk, `${token} → bad device "${prov.device}"`).toBe(true);
            // And the pair it produces must be internally coherent, or the
            // migration would write rows the submit validator would reject.
            expect(
                be.isEngineDeviceCompatible(prov.engine, prov.device),
                `${token} → incompatible pair ${prov.engine}/${prov.device}`,
            ).toBe(true);
        }
    });
});
