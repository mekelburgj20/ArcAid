# Catalogue Duplicate Review

Snapshot of IPDB-shared duplicates remaining after v2.13.0 bulk merge (67 groups auto-merged). The 21 manufacturer-incompatible groups are excluded from this review (separate bucket).

## How to review

Each group below shows its rows, then a **Decision** line **pre-filled with my recommendation** (with a short rationale in *italics*). Go through them one by one and **only edit the Decision line where you disagree** — anything you leave as-is I'll execute as written. Nothing runs against the catalogue until you hand it back.

Decision syntax:

- `merge target=<row-id-prefix>` — merge the OTHER rows into this one. Target keeps its identity (name/mfg/year); merged data unions on.
- `strip-ipdb id=<row-id-prefix>` — clear the (spurious) IPDB link on that row. **This is the "keep them separate / don't dedup" action** — used when the row is a virtual/original/tribute table that merely shares a theme, not the real machine.
- `keep` — leave the rows distinct, untouched.
- `delete id=<row-id-prefix>` — remove a row entirely (last resort).

**Guiding principle (the discriminator is manufacturer):** same *real* manufacturer + shared IPDB = the same machine → **merge** (§1). A *virtual-only* manufacturer (`Zen Studios`), a generic `Original`/`JP's` fan table, or a tribute = a different game → **strip-ipdb, keep separate** (§2).

**Status: ✅ EXECUTED against prod 2026-07-04** — 67 ops (28 merges + 39 strips), 0 failures, 0 scores affected (all merges were score-less catalogue entries). All 60 resolved. Final batch was `tmp/catalogue-dedup-execute.cjs`. Decisions: **Taito do Brasil = same machine (merge)**; **LTD do Brasil (1072) + Rowamet (5696) = distinct clones (strip, keep separate)**; §2 fan/digital rows = strip; §2 mixed 3-row groups = strip the fan row + merge the physical pair. The `⚠` notes on individual groups below are historical (why each was flagged) — all are now decided.

---

## § 1 — Year disagreement (23 groups)

Same name + (real) manufacturer, different year. Same physical machine per IPDB; one source has a stale/wrong year. Resolution: `merge target=<row whose year matches IPDB's authoritative date>`.

### IPDB 4568 — [look up](https://www.ipdb.org/machine.cgi?id=4568)

- **Cavaleiro Negro** (Taito do Brasil, 1980) — vps — vps:`C4q4-3QD` — row id: `e2461811`
- **Cavaleiro Negro** (Taito, 1981) — opdb — opdb:`GrO7w-M9` — row id: `c614f963`

**Decision:** `merge target=c614f963`  *(rec: IPDB=1981 → opdb row)*

### IPDB 5491 — [look up](https://www.ipdb.org/machine.cgi?id=5491)

- **Check Mate** (Taito do Brasil, 1977) — vps — vps:`EZqKpO9f` — row id: `2c2bff3c`
- **Check Mate** (Taito, 1975) — opdb — opdb:`GRBOy-MD` — row id: `6844f65e`

**Decision:** `merge target=2c2bff3c`  *(⚠ rec: IPDB undated; kept the vps row matching IPDB mfg "Taito do Brasil" — year 1977 unconfirmed)*

### IPDB 4567 — [look up](https://www.ipdb.org/machine.cgi?id=4567)

- **Cosmic** (Taito do Brasil, 1980) — vps, wizard — vps:`_EnIegJR` — row id: `3e15eee7`
- **Cosmic** (Taito, 1982) — opdb — opdb:`GrdDB-MP` — row id: `92a005f2`

**Decision:** `merge target=3e15eee7`  *(rec: IPDB=1980 → vps row)*

### IPDB 3968 — [look up](https://www.ipdb.org/machine.cgi?id=3968)

- **Dark Rider** (Geiger, 1984) — vps — vps:`GXUVQCQR` — row id: `0e8679c5`
- **Dark Rider** (Komplett, 1985) — opdb — opdb:`GRVnd-ML` — row id: `43883672`

**Decision:** `merge target=0e8679c5`  *(rec: IPDB=Geiger 1984 → vps row)*

### IPDB 731 — [look up](https://www.ipdb.org/machine.cgi?id=731)

- **Dragonfist** (Stern, 1981) — vps — vps:`dUE459HF` — row id: `90fa3e67`
- **Dragonfist** (Stern Electronics, 1982) — opdb — opdb:`GRQkJ-MD` — row id: `ec7a9eda`

**Decision:** `merge target=90fa3e67`  *(rec: IPDB=1981 → vps row)*

### IPDB 798 — [look up](https://www.ipdb.org/machine.cgi?id=798)

- **Expo** (Williams, 1969) — opdb — opdb:`Gr2jZ-M0` — row id: `23d377fb`
- **Expo** (Williams, ?) — vps — vps:`K_ocAUlf` — row id: `a37a6502`

**Decision:** `merge target=23d377fb`  *(rec: IPDB=1969 → opdb row; vps row is undated)*

### IPDB 979 — [look up](https://www.ipdb.org/machine.cgi?id=979)

- **Galaxy (Sega, 1973)** (Sega, 1973) — vps, wizard — vps:`P_SjStAq` — row id: `a9deb28a`
- **Galaxy** (Sega, 1976) — opdb — opdb:`GrxJV-MD` — row id: `3a244987`

**Decision:** `merge target=a9deb28a`  *(rec: IPDB=1973 → vps row)*

### IPDB 1072 — [look up](https://www.ipdb.org/machine.cgi?id=1072)

- **Grand Prix (Williams, 1976)** (Williams, 1976) — vps, opdb — vps:`wNRPBf_H` · opdb:`G4O1L-MD` — row id: `5de6aa73`
- **Grand Prix** (LTD do Brasil, 1977) — vps — vps:`f9NtgKVh` — row id: `6f6879f9`

**Decision:** `strip-ipdb id=6f6879f9`  *(RESOLVED 2026-07-03: keep the LTD do Brasil licensed clone distinct — strip its Williams IPDB link; Williams `5de6aa73` keeps IPDB, no merge)*

### IPDB 3131 — [look up](https://www.ipdb.org/machine.cgi?id=3131)

- **Gun Men** (Staal, 1979) — vps — vps:`RMHo_Tch` — row id: `0b0ecad5`
- **Gun Men** (Staal, 1977) — opdb — opdb:`GryPE-MN` — row id: `51b67271`

**Decision:** `merge target=0b0ecad5`  *(rec: IPDB=1979 → vps row)*

### IPDB 4618 — [look up](https://www.ipdb.org/machine.cgi?id=4618)

- **Jolly Park** (Spinball S.A.L., 1996) — vps — vps:`hWUnetMt` — row id: `0db001f0`
- **Jolly Park** (Spinball, 1995) — opdb — opdb:`G4jWq-ML` — row id: `f618897f`

**Decision:** `merge target=0db001f0`  *(rec: IPDB=1996 → vps row)*

### IPDB 1365 — [look up](https://www.ipdb.org/machine.cgi?id=1365)

- **Kick Off** (Bally, 1977) — vps — vps:`LF7EDZ7t` — row id: `773048db`
- **Kick Off** (Bally, 1975) — opdb — opdb:`GRzed-MD` — row id: `e1fe962b`

**Decision:** `merge target=773048db`  *(rec: IPDB=1977 → vps row)*

### IPDB 5010 — [look up](https://www.ipdb.org/machine.cgi?id=5010)

- **Lady Luck (Taito do Brasil, 1980)** (Taito do Brasil, 1980) — vps — vps:`sElJa1Np` — row id: `d5f227f7`
- **Lady Luck** (Taito, 1978) — opdb — opdb:`GLWke-M1` — row id: `64c38b0a`

**Decision:** `merge target=d5f227f7`  *(⚠ rec: IPDB undated; kept the vps row matching IPDB mfg "Taito do Brasil" — year 1980 unconfirmed)*

### IPDB 4617 — [look up](https://www.ipdb.org/machine.cgi?id=4617)

- **Mach 2.0 Two** (Spinball S.A.L., 1995) — vps, wizard — vps:`VXjOK2S5` — row id: `a9e1058a`
- **Mach 2** (Spinball, 1994) — opdb — opdb:`G4lVe-MQ` — row id: `17f8659c`

**Decision:** `merge target=a9e1058a`  *(rec: IPDB=1995, title "Mach 2.0 Two" → vps row)*

### IPDB 3970 — [look up](https://www.ipdb.org/machine.cgi?id=3970)

- **Miss World** (Geiger, 1982) — vps — vps:`GMgQDmsJ` — row id: `14ce47d1`
- **Miss World** (Komplett, 1985) — opdb — opdb:`G4jXr-ML` — row id: `674d31d0`

**Decision:** `merge target=14ce47d1`  *(rec: IPDB=Geiger 1982 → vps row)*

### IPDB 5955 — [look up](https://www.ipdb.org/machine.cgi?id=5955)

- **Mississippi** (Recreativos Franco, 1973) — vps — vps:`TqjoPZpv` — row id: `044bc205`
- **Mississippi** (Recreativos Franco, 1970) — opdb — opdb:`GqZVQ-Mw` — row id: `a247a7cd`

**Decision:** `merge target=044bc205`  *(⚠ rec: IPDB undated, same mfr both rows; 1973 vs 1970 unresolved — verify which year)*

### IPDB 3322 — [look up](https://www.ipdb.org/machine.cgi?id=3322)

- **Pole Position** (Sonic, 1987) — vps — vps:`I7mX65rZ` — row id: `11deca4f`
- **Pole Position** (Segasa, 1986) — opdb — opdb:`Grlop-ML` — row id: `14df8377`

**Decision:** `merge target=11deca4f`  *(rec: IPDB=1987, "Segasa d.b.a. Sonic" → vps (Sonic) row)*

### IPDB 5493 — [look up](https://www.ipdb.org/machine.cgi?id=5493)

- **Roman Victory** (Taito do Brasil, 1977) — vps — vps:`Ae2-SG1h` — row id: `8ef4a7cd`
- **Roman Victory** (Taito, 1978) — opdb — opdb:`G2L2p-M4` — row id: `8f1483aa`

**Decision:** `merge target=8ef4a7cd`  *(⚠ rec: IPDB undated; kept the vps row matching IPDB mfg "Taito do Brasil" — year 1977 unconfirmed)*

### IPDB 2156 — [look up](https://www.ipdb.org/machine.cgi?id=2156)

- **Silverball Mania** (Bally, 1980) — vps — vps:`mbQ_5HbH` — row id: `34f072bd`
- **Silverball Mania** (Bally, 1978) — wizard, opdb — opdb:`GRD2P-MD` — row id: `44ee9b6e`

**Decision:** `merge target=34f072bd`  *(rec: IPDB=1980 → vps row)*

### IPDB 5696 — [look up](https://www.ipdb.org/machine.cgi?id=5696)

- **Solar Ride** (Rowamet, 1982) — vps — vps:`3Skym5ZB` — row id: `5d47909f`
- **Solar Ride (Electromatic, 1982)** (Electromatic, 1982) — vps — vps:`EROqFKB-` — row id: `7fbb11ec`
- **Solar Ride** (Electromatic Brasil, 1979) — opdb — opdb:`GRDqo-MQ` — row id: `2d818001`

**Decision:** `strip-ipdb id=5d47909f` + `merge target=2d818001` (source `7fbb11ec`)  *(RESOLVED 2026-07-03: Rowamet is a distinct clone of the Gottlieb Solar Ride → keep it separate by stripping its IPDB link; merge the two Electromatic Brasil rows)*

### IPDB 4583 — [look up](https://www.ipdb.org/machine.cgi?id=4583)

- **Space Shuttle** (Taito do Brasil, 1985) — vps — vps:`nsuhjPvo` — row id: `9bedd651`
- **Space Shuttle** (Taito, 1984) — opdb — opdb:`G4q3L-MK` — row id: `cfc78b69`

**Decision:** `merge target=9bedd651`  *(⚠ rec: IPDB undated; kept the vps row matching IPDB mfg "Taito do Brasil / Mecatronics" — year 1985 unconfirmed)*

### IPDB 2436 — [look up](https://www.ipdb.org/machine.cgi?id=2436)

- **Super Nova** (Game Plan, 1980) — vps — vps:`PeF3uTSU` — row id: `7067ee8c`
- **Super Nova** (Game Plan, 1982) — opdb — opdb:`G56KW-MK` — row id: `338af3ef`

**Decision:** `merge target=7067ee8c`  *(rec: IPDB=1980 → vps row)*

### IPDB 4575 — [look up](https://www.ipdb.org/machine.cgi?id=4575)

- **Vegas** (Taito do Brasil, 1980) — vps — vps:`0Vqc_lNc` — row id: `173211fa`
- **Vegas** (Taito, 1979) — opdb — opdb:`GLWke-Mw` — row id: `34e9edf7`

**Decision:** `merge target=173211fa`  *(⚠ rec: IPDB undated; kept the vps row matching IPDB mfg "Taito do Brasil" — year 1980 unconfirmed)*

### IPDB 5494 — [look up](https://www.ipdb.org/machine.cgi?id=5494)

- **Volley** (Taito do Brasil, 1981) — vps — vps:`5VCFzTKa` — row id: `3c14b35d`
- **Volley** (Taito, 1980) — opdb — opdb:`GrNqO-MR` — row id: `08f91756`

**Decision:** `merge target=3c14b35d`  *(⚠ rec: IPDB undated; kept the vps row matching IPDB mfg "Taito do Brasil" — year 1981 unconfirmed)*

---

## § 2 — Community / digital sharing IPDB (37 groups)

A physical machine sharing an IPDB ID with a fan recreation (`Original` mfr, `JP's` name prefix) or a digital table (`Zen Studios`). The recreation/digital row's IPDB link is spurious. Resolution: `strip-ipdb id=<recreation-row-id>` — **keeps them as separate catalogue entries** (physical keeps IPDB). Mixed 3-row groups also merge the two physical rows.

### IPDB 47 — [look up](https://www.ipdb.org/machine.cgi?id=47)

- **Alice in Wonderland** (Gottlieb, 1948) — wizard, vps, opdb — vps:`9kjJEqft` · opdb:`GkBXQ-M5` — row id: `355628f2`
- **Alice in Wonderland** (Original, 2026) — vps — vps:`8Zt5nV0T` — row id: `92d03dda`

**Decision:** `strip-ipdb id=92d03dda`  *(rec: Original 2026 fan table → keep separate)*

### IPDB 438 — [look up](https://www.ipdb.org/machine.cgi?id=438)

- **Capt. Fantastic and the Brown Dirt Cowboy** (Bally, 1976) — vps, wizard — vps:`ekFqtEr5` — row id: `77ac7c1b`
- **JP's Captain Fantastic** (Bally, 1976) — vps — vps:`SMWmZjvV` — row id: `9e393915`
- **Captain Fantastic and the Brown Dirt Cowboy** (Bally, 1975) — opdb — opdb:`GRveZ-MN` — row id: `1edebb6a`

**Decision:** `strip-ipdb id=9e393915` (JP's) + `merge target=77ac7c1b` (physical `1edebb6a` in)  *(⚠ mixed: separate the JP's fan row; merge the two physical Bally rows, 1975↔1976)*

### IPDB 617 — [look up](https://www.ipdb.org/machine.cgi?id=617)

- **Cyclone** (Williams, 1988) — vps, opdb — vps:`bMuvS7Qz` · opdb:`G4O2b-MJ` — row id: `2c36704f`
- **JP's Cyclone** (Original, 2022) — vps — vps:`yIzKdXh4` — row id: `edb6836b`

**Decision:** `strip-ipdb id=edb6836b`  *(rec: JP's fan table → keep separate)*

### IPDB 6558 — [look up](https://www.ipdb.org/machine.cgi?id=6558)

- **Deadpool (Stern, 2018)** (Stern, 2018) — vps, opdb — vps:`K3qwGUCA` · opdb:`G6lnq-M6` — row id: `fc3288c8`
- **Deadpool** (Zen Studios, 2014) — vps — vps:`-bv6-HSX` — row id: `a546eaea`

**Decision:** `strip-ipdb id=a546eaea`  *(rec: Zen digital table (≠ Stern machine) → keep separate)*

### IPDB 766 — [look up](https://www.ipdb.org/machine.cgi?id=766)

- **El Dorado (Gottlieb, 1975)** (Gottlieb, 1975) — vps, opdb, wizard — vps:`tnAcpB2_` · opdb:`GrEZ5-MD` — row id: `1ab92569`
- **El Dorado** (Zen Studios, 2013) — vps — vps:`2kGICARX` — row id: `d503d7e4`

**Decision:** `strip-ipdb id=d503d7e4`  *(rec: Zen digital table → keep separate)*

### IPDB 871 — [look up](https://www.ipdb.org/machine.cgi?id=871)

- **Flash** (Williams, 1979) — vps, wizard, opdb — vps:`-y7tj2TZ` · opdb:`Grypn-MQ` — row id: `8c12448b`
- **The Flash** (Original, 2018) — vps — vps:`G6X-iHGD` — row id: `8a51714a`

**Decision:** `strip-ipdb id=8a51714a`  *(rec: Original fan table → keep separate)*

### IPDB 6301 — [look up](https://www.ipdb.org/machine.cgi?id=6301)

- **Full Throttle** (Original, 2023) — vps — vps:`QvVohUAb` — row id: `5209bee9`
- **Full Throttle** (Heighway Pinball, 2015) — opdb — opdb:`G5V8q-MQ` — row id: `e119eae9`

**Decision:** `strip-ipdb id=5209bee9`  *(rec: Original "tribute" (not a recreation) → keep separate; physical Heighway `e119eae9` keeps IPDB)*

### IPDB 996 — [look up](https://www.ipdb.org/machine.cgi?id=996)

- **Genesis (Gottlieb, 1986)** (Gottlieb, 1986) — vps, opdb — vps:`yuo1rci6` · opdb:`Gr2wz-ML` — row id: `2458f7da`
- **Genesis** (Original, 2025) — vps — vps:`4Js0x7El` — row id: `a3b24777`

**Decision:** `strip-ipdb id=a3b24777`  *(rec: Original fan table → keep separate)*

### IPDB 1270 — [look up](https://www.ipdb.org/machine.cgi?id=1270)

- **Iron Maiden** (Original, 2017) — vps — vps:`A0hyKr3_` — row id: `7111366a`
- **Iron Maiden (Stern, 1982)** (Stern Electronics, 1981) — opdb — opdb:`G4yZN-MD` — row id: `6b12d17b`
- **Iron Maiden** (Stern, 1982) — wizard, vps — vps:`ptWmhkW0` — row id: `9e8effe3`

**Decision:** `strip-ipdb id=7111366a` (Original) + `merge target=9e8effe3` (physical `6b12d17b` in)  *(⚠ mixed: separate the Original fan row; merge the two physical Stern rows, 1981↔1982)*

### IPDB 5550 — [look up](https://www.ipdb.org/machine.cgi?id=5550)

- **Iron Man (Stern, 2010)** (Stern, 2010) — vps, opdb — vps:`Rg-pW0Ks` · opdb:`GRVq4-ML` — row id: `a24082f2`
- **Iron Man** (Zen Studios, 2010) — vps — vps:`81x-JmcS` — row id: `c291b958`

**Decision:** `strip-ipdb id=c291b958`  *(rec: Zen's own digital table (mfr Zen Studios ≠ Stern) → different game, keep separate)*

### IPDB 5120 — [look up](https://www.ipdb.org/machine.cgi?id=5120)

- **Grand Prix (Stern, 2005)** (Stern, 2005) — vps, opdb — vps:`zgxfvc3S` · opdb:`G5YWX-MD` — row id: `c8d60ea1`
- **JP's Grand Prix** (Stern, 2005) — vps — vps:`GY0RQnml` — row id: `a1840240`

**Decision:** `strip-ipdb id=a1840240`  *(rec: JP's fan table → keep separate)*

### IPDB 5306 — [look up](https://www.ipdb.org/machine.cgi?id=5306)

- **Indiana Jones** (Stern, 2008) — vps, opdb — vps:`NqaGRv8k` · opdb:`G4e1d-MJ` — row id: `f869e738`
- **JP's Indiana Jones** (Stern, 2008) — vps — vps:`ltrFOhE0` — row id: `d095a48c`

**Decision:** `strip-ipdb id=d095a48c`  *(rec: JP's fan table → keep separate)*

### IPDB 6154 — [look up](https://www.ipdb.org/machine.cgi?id=6154)

- **JP's Iron Man 2 - Armored Adventures** (Original, 2018) — vps — vps:`8_XsMlns` — row id: `3894b1be`
- **Iron Man (Pro Vault Edition)** (Stern, 2014) — vps — vps:`zgubR4I-` — row id: `e443cf0d`
- **Iron Man (Vault)** (Stern, 2014) — opdb — opdb:`GRVq4-M4` — row id: `d793d2cd`

**Decision:** `strip-ipdb id=3894b1be` (JP's Iron Man 2) + `merge target=e443cf0d` (physical `d793d2cd` in)  *(⚠ mixed/verify: JP's Iron Man 2 is a different game; merge the two Stern Iron Man Vault rows)*

### IPDB 4077 — [look up](https://www.ipdb.org/machine.cgi?id=4077)

- **JP's Mephisto** (Cirsa, 1987) — vps — vps:`xdbQS4R-` — row id: `27f59a2f`
- **Mephisto** (Unidesa, 1987) — opdb — opdb:`GrqXv-ML` — row id: `875c4e0f`

**Decision:** `strip-ipdb id=27f59a2f`  *(rec: JP's fan table → keep separate; physical Unidesa `875c4e0f` keeps IPDB)*

### IPDB 3631 — [look up](https://www.ipdb.org/machine.cgi?id=3631)

- **JP's Motor Show** (Original, 2017) — vps — vps:`12njfwjI` — row id: `038569c8`
- **Motor Show** (Mr Game, 1989) — opdb — opdb:`GRb2y-MZ` — row id: `dd511cdc`

**Decision:** `strip-ipdb id=038569c8`  *(rec: JP's fan table → keep separate; physical Mr Game `dd511cdc` keeps IPDB)*

### IPDB 2089 — [look up](https://www.ipdb.org/machine.cgi?id=2089)

- **JP's Seawitch** (Stern, 1980) — vps — vps:`Pn4Qv448` — row id: `257d097e`
- **Seawitch** (Stern, 1980) — vps — vps:`x9i_W1Ql` — row id: `855900b9`
- **Seawitch** (Stern Electronics, 1980) — opdb — opdb:`GR6kB-MD` — row id: `0ed455d1`

**Decision:** `strip-ipdb id=257d097e` (JP's) + `merge target=855900b9` (physical `0ed455d1` in)  *(⚠ mixed: separate the JP's fan row; merge the two physical Stern rows)*

### IPDB 5237 — [look up](https://www.ipdb.org/machine.cgi?id=5237)

- **Spider-Man (Stern, 2007)** (Stern, 2007) — vps, opdb — vps:`Uzvrn_qq` · opdb:`G5D94-ML` — row id: `7bd0e844`
- **JP's Spider-Man** (Original, 2018) — vps — vps:`tXARdeGR` — row id: `cb4c85d6`

**Decision:** `strip-ipdb id=cb4c85d6`  *(rec: JP's fan table → keep separate)*

### IPDB 4858 — [look up](https://www.ipdb.org/machine.cgi?id=4858)

- **The Lord of the Rings** (Stern, 2003) — vps, opdb — vps:`5RybGX4Q` · opdb:`GrqZX-MD` — row id: `7d64dfc4`
- **JP's The Lord of the Rings** (Stern, 2003) — vps — vps:`3cxx1oTt` — row id: `a20ad65b`

**Decision:** `strip-ipdb id=a20ad65b`  *(rec: JP's fan table → keep separate)*

### IPDB 6155 — [look up](https://www.ipdb.org/machine.cgi?id=6155)

- **The Walking Dead (Pro)** (Stern, 2014) — vps, opdb — vps:`RoHgIHwY` · opdb:`G5nz5-M3` — row id: `94b9ce88`
- **JP's The Walking Dead** (Original, 2021) — vps — vps:`mO7TA5Pd` — row id: `a4b6eb2a`

**Decision:** `strip-ipdb id=a4b6eb2a`  *(rec: JP's fan table → keep separate)*

### IPDB 5863 — [look up](https://www.ipdb.org/machine.cgi?id=5863)

- **Whoa Nellie! Big Juicy Melons (WhizBang Pinball, 2011)** (WhizBang Pinball, 2011) — vps, opdb — vps:`R8B1EJvx` · opdb:`GRYX4-ML` — row id: `acaa7a29`
- **JP's Whoa Nellie! Big Juicy Melons** (Original, 2022) — vps — vps:`jZ9BEzit` — row id: `f209bd2e`

**Decision:** `strip-ipdb id=f209bd2e`  *(rec: JP's fan table → keep separate)*

### IPDB 6030 — [look up](https://www.ipdb.org/machine.cgi?id=6030)

- **Metallica (Premium Monsters)** (Stern, 2013) — vps, opdb — vps:`oQwWzztd` · opdb:`GRBE4-MJ` — row id: `548d5690`
- **Metallica - Master of Puppets** (Original, 2020) — vps — vps:`2byh2-U-` — row id: `e688dd86`

**Decision:** `strip-ipdb id=e688dd86`  *(rec: Original "Master of Puppets" fan table → keep separate)*

### IPDB 5093 — [look up](https://www.ipdb.org/machine.cgi?id=5093)

- **NASCAR** (Stern, 2005) — vps, wizard, opdb — vps:`7RLpkFAp` · opdb:`G5YWX-MQ` — row id: `61fecc7b`
- **JP's Nascar Race** (Original, 2015) — vps — vps:`wdUEBhIi` — row id: `f33bbdd1`

**Decision:** `strip-ipdb id=f33bbdd1`  *(rec: JP's fan table → keep separate)*

### IPDB 1778 — [look up](https://www.ipdb.org/machine.cgi?id=1778)

- **Pharaoh** (Williams, 1981) — vps, wizard, opdb — vps:`Fwp0OAYN` · opdb:`G41vn-MD` — row id: `1ff53776`
- **Pharaoh - Dead Rise** (Original, 2019) — vps, wizard — vps:`zodqeE8R` — row id: `f09b5c11`

**Decision:** `strip-ipdb id=f09b5c11`  *(rec: Original "Dead Rise" fan table → keep separate)*

### IPDB 1911 — [look up](https://www.ipdb.org/machine.cgi?id=1911)

- **Rainbow (Gottlieb, 1956)** (Gottlieb, 1956) — vps, opdb — vps:`60v8HalZ` · opdb:`GRobp-MD` — row id: `d162ef7f`
- **Rainbow** (Original, 2025) — vps — vps:`0N_gMJG7` — row id: `05f35331`

**Decision:** `strip-ipdb id=05f35331`  *(rec: Original fan table → keep separate)*

### IPDB 1922 — [look up](https://www.ipdb.org/machine.cgi?id=1922)

- **Raven** (Gottlieb, 1986) — vps, opdb — vps:`NurbpY7P` · opdb:`GrJWP-MJ` — row id: `7558e6fa`
- **Rambo** (Original, 2019) — vps — vps:`LFm7pokZ` — row id: `e79c6069`

**Decision:** `strip-ipdb id=e79c6069`  *(rec: "Rambo" (Original) wrongly shares Raven's IPDB — different game entirely → keep separate)*

### IPDB 1979 — [look up](https://www.ipdb.org/machine.cgi?id=1979)

- **Rock Encore** (Gottlieb, 1986) — vps, wizard, opdb — vps:`FFQaRoD2` · opdb:`Grk62-ML` — row id: `69875996`
- **The Clash** (Original, 2018) — vps — vps:`OurZRf_k` — row id: `804e76a4`

**Decision:** `strip-ipdb id=804e76a4`  *(rec: "The Clash" (Original) wrongly shares Rock Encore's IPDB → keep separate)*

### IPDB 2403 — [look up](https://www.ipdb.org/machine.cgi?id=2403)

- **Street Fighter II** (Gottlieb, 1993) — vps, opdb — vps:`LYD7vXqU` · opdb:`G5BYQ-MQ` — row id: `f1b277cd`
- **JP's Street Fighter II** (Original, 2016) — vps — vps:`_8wsc4AY` — row id: `88648d31`

**Decision:** `strip-ipdb id=88648d31`  *(rec: JP's fan table → keep separate)*

### IPDB 2524 — [look up](https://www.ipdb.org/machine.cgi?id=2524)

- **Terminator 2 - Judgment Day** (Williams, 1991) — vps, wizard — vps:`BunvWvh9` — row id: `ebffbecd`
- **JP's Terminator 2** (Original, 2020) — vps — vps:`gyhULWKc` — row id: `e2f53d39`
- **Terminator 2: Judgment Day** (Williams, 1991) — opdb — opdb:`GR9Bx-MQ` — row id: `603a159b`

**Decision:** `strip-ipdb id=e2f53d39` (JP's) + `merge target=ebffbecd` (physical `603a159b` in)  *(⚠ mixed: separate the JP's fan row; merge the two physical Williams rows)*

### IPDB 4787 — [look up](https://www.ipdb.org/machine.cgi?id=4787)

- **Terminator 3 - Rise of the Machines** (Stern, 2003) — vps — vps:`AtQZt7BR` — row id: `fb27bf30`
- **JP's Terminator 3** (Stern, 2003) — vps — vps:`j9F71ZEC` — row id: `186d7e47`
- **Terminator 3: Rise of the Machines** (Stern, 2003) — opdb — opdb:`GR91N-ML` — row id: `d52a6e15`

**Decision:** `strip-ipdb id=186d7e47` (JP's) + `merge target=fb27bf30` (physical `d52a6e15` in)  *(⚠ mixed: separate the JP's fan row; merge the two physical Stern rows)*

### IPDB 20 — [look up](https://www.ipdb.org/machine.cgi?id=20)

- **The Addams Family** (Bally, 1992) — vps, opdb — vps:`aT_GONvw` · opdb:`G4ODR-MD` — row id: `4b2df364`
- **JP's Addams Family** (Bally, 1992) — vps — vps:`id3psEgc` — row id: `32d16ef1`

**Decision:** `strip-ipdb id=32d16ef1`  *(rec: JP's fan table → keep separate)*

### IPDB 4136 — [look up](https://www.ipdb.org/machine.cgi?id=4136)

- **The Lost World Jurassic Park** (Sega, 1997) — vps, opdb — vps:`jpyrfVNT` · opdb:`G4kBL-ML` — row id: `29a78b83`
- **JP's The Lost World Jurassic Park** (Original, 2020) — vps — vps:`YjT7iujj` — row id: `f46dfddf`

**Decision:** `strip-ipdb id=f46dfddf`  *(rec: JP's fan table → keep separate)*

### IPDB 4674 — [look up](https://www.ipdb.org/machine.cgi?id=4674)

- **The Simpsons Pinball Party** (Stern, 2003) — vps, opdb — vps:`qfbl4Ee0` · opdb:`GRvBL-MP` — row id: `cb6b2b34`
- **The Simpsons Treehouse of Horror** (Original, 2020) — vps — vps:`9W6UxaqY` — row id: `159ffed9`

**Decision:** `strip-ipdb id=159ffed9`  *(rec: "Treehouse of Horror" (Original) is a different game sharing IPDB → keep separate)*

### IPDB 6156 — [look up](https://www.ipdb.org/machine.cgi?id=6156)

- **The Walking Dead (Limited Edition)** (Stern, 2014) — vps, opdb — vps:`wasB0RRz` · opdb:`G5nz5-MP` — row id: `6c987455`
- **The Moon Walking Dead (Original, 2017)** (Original, 2017) — vps — vps:`HWNBg_x5` — row id: `b35cea08`

**Decision:** `strip-ipdb id=b35cea08`  *(rec: "The Moon Walking Dead" (Original) → keep separate)*

### IPDB 4137 — [look up](https://www.ipdb.org/machine.cgi?id=4137)

- **The X Files (Sega, 1997)** (Sega, 1997) — vps, opdb — vps:`ImqfuWt4` · opdb:`G4jPq-MQ` — row id: `f1662a44`
- **The X Files** (Original, 2021) — vps — vps:`5NfcMMW_` — row id: `3e414c4b`

**Decision:** `strip-ipdb id=3e414c4b`  *(rec: Original fan table → keep separate)*

### IPDB 6617 — [look up](https://www.ipdb.org/machine.cgi?id=6617)

- **Thunderbirds** (Original, 2022) — vps — vps:`gYo_y3x_` — row id: `c68083ff`
- **Thunderbirds** (Homepin, 2018) — opdb — opdb:`GN6Lq-Mr` — row id: `53404426`

**Decision:** `strip-ipdb id=c68083ff`  *(rec: Original fan table → keep separate; physical Homepin `53404426` keeps IPDB)*

### IPDB 5709 — [look up](https://www.ipdb.org/machine.cgi?id=5709)

- **Transformers (Pro)** (Stern, 2011) — vps, wizard, opdb — vps:`liKT-fsT` · opdb:`GRnPz-Mx` — row id: `5ada8823`
- **JP's Transformers** (Original, 2018) — vps — vps:`tQwyafuX` — row id: `9df1e98a`

**Decision:** `strip-ipdb id=9df1e98a`  *(rec: JP's fan table → keep separate)*

### IPDB 1745 — [look up](https://www.ipdb.org/machine.cgi?id=1745)

- **Panthera** (Gottlieb, 1980) — vps, wizard, opdb — vps:`XcDjsAyH` · opdb:`G5bQq-MQ` — row id: `ae3b1d64`
- **TRON Classic** (Original, 2018) — vps — vps:`Sq1UUBL6` — row id: `59f955a4`

**Decision:** `strip-ipdb id=59f955a4`  *(rec: "TRON Classic" (Original) wrongly shares Panthera's IPDB → keep separate)*
