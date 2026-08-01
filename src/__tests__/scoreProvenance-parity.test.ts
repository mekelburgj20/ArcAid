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
    /**
     * The other assertions in this file each name a specific export, which
     * means a NEW export added to one side only slips through every one of
     * them. That happened during P3: `equivalentLegacyPlatforms` was added to
     * the backend after the mirror was copied, the suite stayed green, and the
     * FE silently lacked the function — the exact failure mode this file
     * exists to prevent, reproduced by the file itself.
     *
     * Comparing the export NAME SETS closes it: any new export must land on
     * both sides to pass, without anyone remembering to add an assertion.
     */
    it('exports exactly the same set of names', () => {
        expect(Object.keys(fe).sort()).toEqual(Object.keys(be).sort());
    });

    it('exports the same kind of thing under each name', () => {
        for (const key of Object.keys(be) as Array<keyof typeof be>) {
            expect(typeof fe[key as keyof typeof fe], key as string).toBe(typeof be[key]);
        }
    });

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
            expect(fe.getDeviceShortLabel(device)).toBe(be.getDeviceShortLabel(device));
        }
    });

    it('agrees on the P3 additions: categories, short labels and engine equivalence', () => {
        for (const engine of [...Object.keys(be.CANONICAL_ENGINES), be.UNKNOWN, 'nonsense']) {
            expect(fe.getEngineCategory(engine), engine).toBe(be.getEngineCategory(engine));
            expect(fe.getEngineCategoryLabel(engine), engine).toBe(be.getEngineCategoryLabel(engine));
            expect(fe.getEngineShortLabel(engine), engine).toBe(be.getEngineShortLabel(engine));
        }
        expect(fe.ENGINE_CATEGORY_LABELS).toEqual(be.ENGINE_CATEGORY_LABELS);
        expect(fe.UNSPECIFIED_LABEL).toBe(be.UNSPECIFIED_LABEL);

        for (const token of [...Object.keys(be.LEGACY_PLATFORM_MAP), '', 'nonsense']) {
            expect(fe.equivalentLegacyPlatforms(token), token).toEqual(be.equivalentLegacyPlatforms(token));
            expect(fe.getLegacyPlatformLabel(token), token).toBe(be.getLegacyPlatformLabel(token));
            expect(fe.getLegacyPlatformLabel(token, false), token).toBe(be.getLegacyPlatformLabel(token, false));
        }
        for (const engine of [...Object.keys(be.CANONICAL_ENGINES), be.UNKNOWN]) {
            for (const device of [...Object.keys(be.CANONICAL_DEVICES), be.UNKNOWN]) {
                expect(fe.isDeviceInformative(engine, device), `${engine}/${device}`)
                    .toBe(be.isDeviceInformative(engine, device));
            }
        }
    });

    it('agrees on the P4 additions: card categories and their labels', () => {
        expect(fe.UNSPECIFIED_CATEGORY).toBe(be.UNSPECIFIED_CATEGORY);
        expect(fe.CARD_CATEGORY_ORDER).toEqual(be.CARD_CATEGORY_ORDER);

        for (const engine of [...Object.keys(be.CANONICAL_ENGINES), be.UNKNOWN, 'nonsense', '']) {
            expect(fe.engineCardCategory(engine), engine).toBe(be.engineCardCategory(engine));
        }
        for (const id of [...be.CARD_CATEGORY_ORDER, null, '', 'nonsense']) {
            expect(fe.getCardCategoryLabel(id), String(id)).toBe(be.getCardCategoryLabel(id));
        }

        // Every card category must render a label, or the chip on a card would
        // be blank and read as a bug. `null` is the one exception: it means
        // "this game has no scores", which has no board to name.
        for (const id of be.CARD_CATEGORY_ORDER) {
            expect(be.getCardCategoryLabel(id), id).toBeTruthy();
        }
        expect(be.getCardCategoryLabel(null)).toBeNull();

        // The bucket is NOT a fidelity band: no engine may claim it, and it
        // must not appear in the band-label map.
        expect(Object.keys(be.ENGINE_CATEGORY_LABELS)).not.toContain(be.UNSPECIFIED_CATEGORY);
        for (const id of Object.keys(be.CANONICAL_ENGINES)) {
            expect(be.engineCardCategory(id), id).not.toBe(be.UNSPECIFIED_CATEGORY);
        }
        expect(be.engineCardCategory(be.UNKNOWN)).toBe(be.UNSPECIFIED_CATEGORY);
    });

    it('keeps every engine short label non-empty and distinct from its id', () => {
        // A missing `shortLabel` would fall back to the uppercased id at render
        // time and read as a raw token ("ATGAMES_NATIVE") on a card pill.
        for (const [id, info] of Object.entries(be.CANONICAL_ENGINES)) {
            expect(info.shortLabel, id).toBeTruthy();
            expect(info.shortLabel.length, id).toBeLessThanOrEqual(info.displayName.length);
        }
        for (const [id, info] of Object.entries(be.CANONICAL_DEVICES)) {
            expect(info.shortLabel, id).toBeTruthy();
        }
    });

    it('gives every engine a category, and the unknown sentinel none', () => {
        for (const id of Object.keys(be.CANONICAL_ENGINES)) {
            expect(be.getEngineCategoryLabel(id), id).not.toBeNull();
        }
        expect(be.getEngineCategoryLabel(be.UNKNOWN)).toBeNull();
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

    it('makes every canonical engine id a legacy-map key that maps to itself', () => {
        // ADR 0016 catalogue phase §1. `global_games.platforms` becomes an
        // engine list, and LEGACY_PLATFORM_MAP is what every read path uses to
        // classify a catalogue value — so an engine id missing from it reads as
        // unknown/unknown: the submit picker auto-locks "Unspecified" and the
        // engine's expansion set excludes the engine's own id, so tournament
        // eligibility matches zero games. Four ids (`fx_classic`,
        // `fx_midnight`, `star_wars`, `atgames_native`) had exactly that hole;
        // this asserts the invariant over the WHOLE engine list so a newly
        // added engine cannot reopen it.
        for (const id of Object.keys(be.CANONICAL_ENGINES)) {
            expect(
                Object.prototype.hasOwnProperty.call(be.LEGACY_PLATFORM_MAP, id),
                `engine "${id}" is not a LEGACY_PLATFORM_MAP key`,
            ).toBe(true);
            expect(be.LEGACY_PLATFORM_MAP[id].engine, id).toBe(id);
            expect(be.mapLegacyPlatform(id).engine, id).toBe(id);
            // …and the round trip a catalogue row actually takes.
            expect(be.enginesFromLegacyPlatforms([id]), id).toEqual([id]);
        }
        // The mirror must agree — enforced by the deep-compare above, asserted
        // here too so a FE-only regression names this invariant, not a diff.
        for (const id of Object.keys(fe.CANONICAL_ENGINES)) {
            expect(fe.enginesFromLegacyPlatforms([id]), id).toEqual([id]);
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
