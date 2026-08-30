# Arcaid Witness for Desktop VPX — plan

> **Read this first if you are picking up desktop-VPX-witness work.** It is self-contained:
> everything a fresh session needs to act is here. The raw evidence and probe scripts live in
> `tmp/vpx-desktop-witness/` (gitignored — see [Evidence trail](#evidence-trail)), but you do
> not need them to understand the plan.
>
> Status: **design locked, first probes proven, awaiting the owner's live tests (Round A/B).**
> Nothing is built yet. Last updated 2026-08-30.

## 1. What this is

A Windows agent that watches Visual Pinball X and reports **scores and game events** to Arcaid,
so a room can run tournaments on desktop VPX the way it already can on AtGames cabinets:
per-game boundaries for "Best of 5", and launch-time evidence to catch gear-up (starting a game
before the round opens and submitting it after).

It is the desktop sibling of the cabinet Arcaid Witness (ADR 0020 / 0021). Same doctrine:
**evidence with a method tag, badge-never-gate.** No verdict ever filters a board or changes a
rank.

## 2. Owner rulings (locked — do not re-litigate)

| Ruling | Date | Consequence |
|---|---|---|
| **Target VPX 10.8.0 only.** 10.8.1 is beta and not release-ready. | 2026-08-30 | No plugin tier. The in-process route is a script hook. |
| **Near-zero barrier to entry**: download → click install → ≤2 wizard choices → done. | 2026-08-30 | Default install modifies nothing; no admin; no COM registration; no firewall prompt. |
| **Node/TypeScript** for the agent. | 2026-08-30 | Reuses `scripts/witness-agent.ts` pairing + reporting, so cabinet and desktop share one implementation. |
| Cabinet witness ships first. | 2026-08-29 | This work is sequenced after the cabinet RC + graduation event. |

## 3. Why this is possible (verified facts, not inference)

All verified on the owner's rig (`C:\Users\mekel\Documents\Emulators\VPX\VisualPinballX`,
VPX 10.8.0, 134 tables, VPinMAME 3.7.0.222) on 2026-08-30.

1. **Scores live in NVRAM, and the maps to decode them are public.**
   `tomlogic/pinmame-nvram-maps` (ODbL, ~1,500 ROM entries) maps each ROM's memory, including a
   `game_state` block with **per-player scores for the game just played**, current ball, player
   up, and a game-over flag. Proven locally: `tftc_400` → Player 1 663,929,960 / Game Over true;
   `ij_l7` → 428,542,550 plus a `last_played` timestamp.
2. **This is the same mechanism the AtGames cabinet scoreserver uses.** That scoreserver is
   `superhac/score-server` (public C++ VPX plugin, **no LICENSE file — read-only reference,
   ask before vendoring**) embedded in a closed Legends Unchained VPX fork. Its signed records
   and its backend are the launcher's, not the plugin's. Desktop and cabinet therefore share a
   data source and can share an event vocabulary.
3. **The live-score plumbing already ships inside VPX 10.8.0.** Shared `scripts/core.vbs`
   (VPinMAMEDriverVer 3.61), `Sub PinMAMETimer_Timer` **line 2457**, already calls
   `Controller.ChangedNVRAM` every frame and passes the changed bytes to a `NVRAMCallback` hook
   — gated by `UseVPMNVRAM` (line 37), with `Dim NVRAMCallback` (line 38). Our entire injection
   is: set the flag before core.vbs loads, and register the callback after.
4. **One shared file covers the whole ROM library.** Every manufacturer driver script
   (`Bally.vbs`, `de.vbs`, `gts3.vbs`, … 40+) does `ExecuteGlobal GetTextFile("core.vbs")`.
   Measured over the owner's 134 tables:

   | | |
   |---|---|
   | load shared `controller.vbs` | 127 (95%) |
   | use VPinMAME (ROM tables) | 131 (98%) |
   | carry their **own embedded** copy of core.vbs | **0** — nothing escapes a shared patch |
   | already use `NVRAMCallback` | **0** — no conflict to chain around |
   | non-VPM originals | 3 (two are test/calibration tables) |

5. **Sidecar external scripts work on 10.8.0** — the exe contains `MODIFYING EXTERNAL SCRIPT: `
   and `Save externally loaded .vbs script also to .vpx table?`. `vpxtool` v0.33.9 does the
   extract/import round-trip. This is how we test without touching a real install, and the
   fallback for per-table opt-in.
6. **An external process can never read a live game.** `VPinMAME.Controller` and `B2S.Server`
   are both `InprocServer32`. Anything live must run inside the VPX process — which is why the
   script hook is the answer rather than a convenience.
7. **NVRAM is flushed to disk only when the table exits.** A hard kill loses the score entirely.

## 4. Architecture

### Two modes, and the second is optional

**Basic mode — the default, modifies nothing.**
Watch for `VPinballX*.exe` starting (its command line carries `-Play "<table>.vpx"`, giving the
table identity and a launch timestamp), then on exit decode the `.nv` file and diff
`user/VPReg.stg`. Delivers table, session window, and final per-player score with **zero
changes to the user's Visual Pinball**. Granularity matches the AtGames exit-to-submit model,
so round windows and coarse gear-up detection work on day one.

**Live mode — one-click opt-in, offered after basic mode has proven itself.**
Adds `arcaid.vbs` to the VPX `scripts/` folder plus **one `ExecuteGlobal` line** in `core.vbs`.
The hook is pure VBScript and does exactly one thing: append changed NVRAM bytes to a journal
file. The agent maintains the shadow NVRAM, decodes with the maps, and derives real per-game
and per-ball events. This is what makes exact Best-of-5 and precise gear-up detection possible.

We never ask a stranger to let us edit their pinball setup as a precondition of installing.

### Deliberate exclusions

- **No in-process COM DLL.** Avoids admin/UAC, x86-vs-x64 build matching (VPX ships both), the
  AV heuristic that most resembles malware, and a class of registration support tickets.
- **No localhost socket.** IPC is a **journal file the hook appends and the agent tails**. No
  firewall prompt, and — importantly — **the agent does not need to be running during play**;
  the journal is ingested later, which is precisely the `via=retro` concept already implemented
  server-side (ADR 0021). This removes the "did you start Arcaid first?" failure mode.
- **No memory reading.** External `ReadProcessMemory` (anchored by pattern-matching known `.nv`
  contents) stays an unused reserve; it invites AV trouble for little gain.

### Install/runtime behaviour

- **Auto-detection, verified:** `HKCR\VPinMAME.Controller\CLSID` → `InprocServer32` gives the
  VPinMAME DLL path; its grandparent is the VPX root, confirmed by the presence of
  `scripts\core.vbs` and `tables\`. Check `WOW6432Node` in parallel to learn the bitness.
- **Self-healing beats being right up front.** The always-on process watch sees every launch's
  exe path, so it discovers installs the wizard never knew about *and* detects our hook being
  overwritten by a user's VP script-package update — the number-one silent-death scenario. It
  offers a one-click re-patch instead of going quiet mid-tournament.
- **Wizard:** install (per-user, no admin) → sign in to Arcaid via browser (reuse
  `witness_devices` pairing with a desktop device type; deferrable — it can journal first and
  pair later) → *"Found Visual Pinball at `<path>`"* with capture on and a clearly-explained
  live-mode checkbox → tray icon, "Start with Windows" on by default. Nothing else is asked.
- **Trust surface:** tray shows proof of life (*"Last capture: Tales from the Crypt —
  663,929,960, 2 min ago · Live mode on · 131 tables instrumented"*); a first-class **"Remove
  Arcaid from Visual Pinball"** button restores the backup; the hook lives in its own file so
  the `core.vbs` change is one diffable line; the hash manifest doubles as an attestation asset
  the witness can verify at round start.

### Forward compatibility

Define the **event schema and the journal format as the product boundary**. The in-VPX producer
is then swappable: script hook today, a 10.8.1+ plugin later emitting identical events, agent
unchanged. Same split as the cabinet's beacon/reporter.

## 5. Coverage and honest limits

- **100 of the owner's 138 NVRAM files** have `game_state` maps (last-game scores). 105 are
  mapped at all.
- **The gap is the modern Sterns he plays most** — `acd_170h`, `bdk_294`, `mtl_180h`,
  `trn_174h`, `twd_160h` (SAM/SPIKE) are mapped but have no `game_state`. High scores still
  parse. Contributing maps upstream is an option (ODbL, tooling in the repo).
- **Index coverage is optimistic**: a generic fallback map counts as "covered" and can still
  yield nothing (confirmed independently against the cabinet corpus, SPRINT_STATUS #128).
- **Originals/EM tables:** `VPReg.stg` (an OLE compound file, parses easily) holds only a
  top-N high score list — **no last-game score exists for originals** anywhere in the desktop
  ecosystem. But the cabinet corpus shows the LU scoreserver *does* emit live per-ball scores
  for non-PinMAME tables, so a **second, script-side channel exists** in `superhac/score-server`.
  **Read that source before designing originals support**; if the channel is in the public
  plugin, desktop gets originals too. Stay call-compatible with its documented
  `VPinball.ScoreServer` API (`SetGameName`, `SetScoresArray`, `SetGameState`, `AwardBadge`) so
  already-integrated tables work unmodified.
- **Nothing else on desktop does any of this.** PINemHi, VPin Studio and PinUP Popper are all
  post-exit parsers driven by frontend exit events; none capture live scores, game start/stop,
  last-game scores for originals, or any anti-tamper signal.

## 6. Build phases

| Phase | Deliverable | Gated on |
|---|---|---|
| **P0** | Owner runs Round A + B tests below | — |
| **P1** | Journal + event schema spec (the product boundary), shared with the cabinet vocabulary | A1 result |
| **P2** | **Basic-mode agent** (Node/TS): process watch, `.nv` + VPReg decode, pairing reusing `scripts/witness-agent.ts`, tray UI. **This is the shippable product.** | B1 |
| **P3** | Installer: single self-contained exe, per-user, Inno Setup or Velopack (prefer built-in delta auto-update — a stale agent mid-tournament is a support burden). Bundle the maps corpus with background refresh. **ODbL attribution required in the About box.** | P2 |
| **P4** | **Live mode**: `arcaid.vbs` hook, installer patch/restore with hash manifest, self-heal detection | A1 + P2 |
| **P5** | Server side: desktop device type, ingest endpoint, method/via tags in verdicts, Best-of-5 round semantics | P4 |
| **P6** | Originals support (after reading `superhac/score-server`'s second channel) | P5 |

Code signing (§8) must be resolved before P3 ships to anyone outside the test group.

## 7. Tests the owner needs to run

Ordered. **Round A and B are the blockers** — everything else waits on them. Staged tests need
no preparation; just follow the run line.

### Round A — does the live path work? (decides P1/P4)

**A1 · Live NVRAM capture, Data East (STAGED — run this first)**
*Why:* the single decisive test. Proves live scores are readable on 10.8.0 with no plugin.
*Setup:* already staged; **touches nothing in your real install** (a copy of the table plus a
sidecar script).
*Run:* open `tmp\vpx-desktop-witness\t7-sidecar\ArcaidTest_TFTC.vpx` in your normal
`VPinballX64.exe`. Play a full game, **drain all 3 balls to reach Game Over**; play a second
game if you can. Quit normally (not a hard kill). Then:
`python C:\code\repos\ArcAid\tmp\vpx-desktop-witness\decode-live.py`
*Success:* Player 1 score climbing during play; Ball advancing 1→2→3; Game Over flipping at
drain and back at the next game start.
*Also record:* the alignment line it prints first — whether `Controller.NVRAM` indexes match
on-disk `.nv` offsets. That is the one genuine unknown; if it says CHECK OFFSET we need a fixed
shift for live reads.
*Full instructions:* `tmp\vpx-desktop-witness\SETUP-T7.md`.

**A2 · Live capture on a Williams WPC table (needs staging — ask an agent)**
*Why:* A1 only proves one ROM platform. WPC is the biggest family in most collections.
*Run:* same recipe against Indiana Jones (`ij_l7`), which is already in your ROM set.
*Success:* same three signals as A1, proving the decode generalises across platforms.

**A3 · Modern Stern check (needs staging)**
*Why:* to confirm and document the known gap rather than discover it in a tournament.
*Run:* same recipe against Batman Dark Knight (`bdk_294`) or Walking Dead (`twd_160h`).
*Expected:* deltas flow but no `game_state` decode. Confirms these need upstream maps, and
shows what *is* available meanwhile.

### Round B — the timing spine (decides P2, no modification needed)

**B1 · Process watch during a normal session (STAGED)**
*Why:* this is the tamper-resistant backbone of basic mode and of gear-up detection.
*Run:* `powershell -File C:\code\repos\ArcAid\tmp\vpx-desktop-witness\witness-watch.ps1` in its
own window, then play normally across **two or three different tables**, and quit each. Ctrl+C
when done; results land in `witness-watch.jsonl`.
*Success:* a `table_launch` with the correct `.vpx` path and a `table_exit` with a sane session
length, for every table.

**B2 · Launch through your frontend (if you use one)**
*Why:* most players launch via PinUP Popper / PinballX / PinballY, not the VPX editor. The
detection must be identical.
*Run:* B1's watcher running, but start tables from the frontend.
*Success:* same events, same table paths.

**B3 · Hard kill vs clean exit**
*Why:* documents a failure mode we must handle rather than be surprised by.
*Run:* with the watcher on, play a game, then kill VPX from Task Manager instead of quitting.
Check whether the ROM's `.nv` timestamp updated.
*Expected:* it does **not** — the score is lost. Confirms live mode's real value and tells us
what basic mode must warn about.

### Round C — post-exit accuracy (validates basic mode's numbers)

**C1 · A losing game**
*Why:* the differentiator. Every existing tool captures high scores; we claim the *last* score.
*Run:* play a deliberately bad game on a mapped table (a table you have a high score on), exit,
then `python tmp\vpx-desktop-witness\parse-nv.py <rom>`.
*Success:* `game_state` shows your poor score, not the high-score table's entry.

**C2 · Two-player game**
*Why:* Best-of-5 and event boards need per-player attribution.
*Run:* start a 2-player game, give the players clearly different scores, exit, parse.
*Success:* Player 1 and Player 2 both correct and distinguishable.

**C3 · An original / script-only table**
*Why:* to see exactly what is and isn't persisted for non-ROM tables.
*Run:* note the modified time of `user\VPReg.stg`, play an original, exit, and re-inspect.
*Success (either way, it is data):* we learn whether anything beyond a top-N list is written.

### Round D — product robustness (after P2/P3 exist, not now)

- **D1 · Clean-machine install** — a PC that has never run our code, to see the real SmartScreen
  and antivirus behaviour. This is the adoption test, and it is worth doing early enough to fix.
- **D2 · Auto-detect on a different layout** — another rig, ideally with VPX somewhere other
  than `Documents`, or with the 32-bit build.
- **D3 · Hook survival** — install live mode, then update your VP script package over it, and
  confirm the agent notices and offers to re-patch.
- **D4 · Performance A/B** — the same table with the hook on and off; confirm no frame-time
  impact. The hook runs at frame rate, so this is not optional before shipping live mode.

## 8. Risks and blockers

1. **Code signing / SmartScreen — the number-one adoption killer.** An unsigned downloaded exe
   shows "Windows protected your PC" and most players stop there. Needs an OV or EV certificate
   (~$200–400/yr) plus reputation accumulation. **Budget before launch, not after.**
2. **Antivirus false positives.** We edit game scripts and watch processes. Dropping the
   injected DLL removes the worst signature; sign, and submit to Defender/vendors.
3. **Defender Controlled Folder Access** can block writes under `Documents`, where this rig's
   VPX lives. Detect and explain; never fail silently.
4. **`ChangedNVRAM` is a destructive delta read** — calling it clears pending changes. Exactly
   one consumer; the shadow copy is mandatory; if a table ever registers its own callback we
   must pass the same array through. All real work belongs in the agent, never in VBScript, and
   journal writes must be buffered (the probe flushes every 100 callbacks for this reason).
5. **`superhac/score-server` has no LICENSE file.** Reference only; ask before reusing code.
   The nvram maps are ODbL — **attribution is required**.
6. **VP script-package updates** overwriting the hook — mitigated by self-heal (§4).

## 9. Open questions

- Does `Controller.NVRAM`'s array index match on-disk `.nv` offsets? (**A1 answers this.**)
- What is `score-server`'s second, script-side channel for non-PinMAME tables? (Read the source
  before P6.)
- Contact `superhac` about licensing and possible collaboration; he also authors the `vpinfe`
  frontend, a plausible distribution ally.
- Should we contribute SAM/SPIKE `game_state` maps upstream to close our own worst gap?
- Installer: Inno Setup vs Velopack (auto-update) — decide at P3.

## Evidence trail

Working files are in `tmp/vpx-desktop-witness/` (gitignored; a memory entry named
`vpx-desktop-witness` points at it):

| File | What it is |
|---|---|
| `FINDINGS-D0-local-inventory.md` | the rig inventory |
| `FINDINGS-D1-research-synthesis.md` | full research synthesis, ecosystem map, scoreserver identification |
| `FINDINGS-D2-1080-only-design.md` | the 10.8.0-only architecture |
| `FINDINGS-D3-zero-barrier-packaging.md` | packaging and onboarding |
| `SETUP-T7.md`, `t7-sidecar/`, `decode-live.py` | test A1, staged |
| `witness-watch.ps1` | test B1, staged |
| `parse-nv.py`, `coverage-report.mjs`, `scan-tables.mjs` | the probes behind §3 and §5 |
| `pinmame-nvram-maps/`, `py-pinmame-nvmaps/`, `vpxtool/` | cloned dependencies |
| `vpx-10.8.1-test/` | parked 10.8.1 environment, kept only as a decode oracle |

Cabinet-side context: `tmp/atgames-research/FINDINGS-0q` … `0s`, ADR 0020, ADR 0021, and
SPRINT_STATUS markers #127 / #129 / #130.
