# Arcaid Witness Record Proposal v1

Nov 4, 2026 · mekelburgj · DRAFT for Legends Unchained review

This is my side of the integrity conversation as a concrete proposal: what Arcaid needs from a cabinet score to mark it verified, why each field matters, and what I can do without any change on your side. Everything is additive to the ScoreServer record you already sign, and none of it asks a player or a tournament runner to do anything.

Where I describe your stack, it is my reading of the public repo and the files on a cabinet. Please correct anything I have wrong.

## 1. How I understand the pieces

- The ScoreServer lives inside the VPX fork, configured by the `ScoreServer*` keys in the global VPX ini. It writes a signed `game_end` record per game and a live state file with `table_loaded` and `game_start` events. Since it already signs, it is the natural home for anything attested at play time.
- A Wizard table is the author's `.vpx` plus your config bundle. Table Manager verifies the download against `vpxChecksum`, published in the manifest as `tableChecksum` (MD5 of the original file). The bundle has its own identity, `configVersion`, and for some tables ships a `table.vbs` that replaces the script inside the `.vpx`.
- Stable releases are never deleted and `table-history.json` records every version that shipped, so any checksum or configVersion that was ever official remains knowable.

## 2. What "verified" means in Arcaid

A few Arcaid terms used below:

- **Witness app**: the small app on the cabinet (and Castcade, its desktop counterpart on PC) that is paired to a player's Arcaid account. It reads the ScoreServer journal and reports each game to Arcaid; Arcaid routes the play to whatever tournaments the player is in.
- **Tournament runner**: whoever configures a tournament in Arcaid. Players never configure anything beyond the one-time pairing.
- **Open play** (default) and **Sanctioned play**: a per-tournament setting chosen by the runner. In Open play every score counts and integrity evidence only produces a badge on the score. In Sanctioned play a score whose evidence fails the runner's rules is kept off that tournament's board.
- **Limited attempts**: a tournament format where each player gets N attempts per table, counted from the moment a game starts.
- **Global Scoreboard**: the player's personal, cross-room record of every score, independent of any tournament.

Arcaid never refuses a score on the strength of a badge. A score with weak or missing evidence still lands on the Global Scoreboard and, in Open play, on the tournament board with a badge stating what was and was not checked. Only a Sanctioned play tournament withholds a flagged score, and only from that one board. Every field below changes a label, not whether a play counts.

For a cabinet score I want to answer four questions:

1. Is the record genuine? Your signature covers this today.
2. Is the table genuine? Was the file and the script that ran the one you shipped?
3. Did the game happen when and where it says? Timing and device, cross-checked against the Witness app on the same cabinet.
4. Were the fairness settings stock? Difficulty, tilt and nudge, PinMAME cheat flag, free play and ball count.

Today I can answer 1 and most of 3. The rest is what this proposal adds.

## 3. Table identity

We initially discussed an OLE stream hash because the DRM gives every shipped file a unique hash. On a second look I think the manifest already has what is needed:

- The fork decrypts the table to play it, so at load it can compute the MD5 of the plaintext file. That equals `tableChecksum` in the manifest and equals what a PC copy of the same release hashes to, so one value identifies the table across cabinets and desktops.
- `configVersion` identifies the bundle, and therefore the script and ini set the cabinet ran. The pair pins down exactly what was played.
- The stream hash is only needed where the BASS fix tool has rewritten the file. The manifest flags those tables with `applyFixes`, so it can remain a v2 item for that case.

Arcaid will ingest `tableChecksum`, `configVersion` and the release history from the manifest on every release. A table installed from a user's fork, or an older bundle version that was once official, is reported as unverified, never flagged.

The one assumption this rests on: the fork sees the decrypted `.vpx` as an ordinary OLE file at load, so the plaintext MD5 is computable. Please confirm.

## 4. Proposed additions to the signed record

All optional, all inside the signed payload. Names are suggestions.

| Field | Source | Purpose |
|---|---|---|
| `table_md5` | plaintext `.vpx` at load | Table identity, matched against the manifest; same value on PC |
| `config_version` | the installed bundle | Which script and ini set ran; distinguishes fork installs |
| `script_sha256` | the script actually executed, embedded or sidecar `table.vbs` | Script integrity independent of the file |
| `game_id` | one id per game, shared by its start and end records | Several records for one game are never counted as several games (Stern SAM writes one `game_over` per ball) |
| `balls_played`, `ball_in_play`, `quit` | the recorder's game state | Quits become visible on SAM tables; a quit still counts, it is only labelled |
| `cheat` | `pinmame.ini` `[settings] cheat` for the ROM | Must be 0 for any serious board |
| `adjustments` | NVRAM values already decoded through the memory maps: free play, balls per game | Lets me allow your defaults (free play on, extra ball on replay) and notice anything else |
| `ini` | effective values at game start: `Difficulty`, `TiltSensitivity`, `PBWAccelGainX/Y`, `4kpAccelEnabled`, nudge keys | Fairness baseline. Difficulty applies at the next launch, so one sample at start covers the sitting. The stock baseline will be your shipped defaults, not upstream VPX's |
| `clock_offset_sec`, `ntp_synced` | the offset the launcher already logs ("clock is 39h55m behind the server") | A tester's cabinet came up 40 hours behind at power-on; with the offset in the record the game is placed correctly |
| `machine_id`, `device_model` | a per-install UUID instead of `alp4k-01`, plus the model id | The record carries provenance, so the signature proves this cabinet rather than an LU build |
| `kid` | signing key id | Key rotation without a flag day |
| `scoreserver_version`, `launcher_version`, `bundle_version` | the build | Read each record by the rules of the build that wrote it |

## 5. A signed `game_start` record

The state file already emits `game_start`. Writing the same event to the signed journal, with the `game_id` and the `ini` and `adjustments` samples above, gives:

- Attempts in a Limited-attempts tournament counted at the moment the game starts, as on desktop.
- A game lost to a power cut or crash still has a start, so the attempt is accounted for and the player sees why.
- No need for the Witness app to infer a start from file timestamps.

## 6. A tournament profile in the fork

You described a tournament-only launcher with a forced clean install. Since the fork already regenerates the per-table ini from the shipped default at launch, most of that could be a profile rather than a separate build:

- When the effective ini differs from the shipped base, `cheat=1`, or the table hash is not a known one for the slug: refuse to launch, or launch and mark the record `profile: tournament` absent.
- Stamp the profile into every record of the sitting.

Arcaid would treat `profile: tournament` as the cabinet equivalent of a desktop Sanctioned-play pass, shown to the runner as a single badge.

## 7. Items that need no change from you

- `ScoreServerBroadcastMode = 1` (WebSocket, port 3131) already exists. If shipping it on by default or per table is acceptable, the Witness app on the same cabinet can consume live events instead of tailing files. Does the broadcast carry `sig`?
- Castcade, the desktop companion, will add the plaintext MD5 beside its SHA-256 so desktop and cabinet identity use the same value.
- Arcaid ingests the manifest fields now and keeps the per-game required table / ROM / fingerprint override for runners using tables outside your catalogue.

## 8. What Arcaid commits to

- Every field is optional; a malformed one is dropped, never an error. A record without the new fields behaves exactly as today.
- Fields are badges, never gates, except inside a tournament the runner has explicitly set to Sanctioned play.
- The cabinet ingest rules are published, and the same code evaluates a score at ingest and on the runner's review page, so the two cannot disagree.
- A conformance script with a test keypair, so a record format can be checked without a cabinet.

## Open questions

1. Can the fork compute the plaintext MD5 at load? This one answer picks between three designs of very different cost and strength, which is why it comes first.
   - **Yes**: table identity is done with no new infrastructure. The value already exists in the manifest, Table Manager already verifies it at install, a PC copy hashes to the same value, and a hash taken at load catches a file swapped after install. No new hash definition, no new manifest field, nothing for Castcade and the fork to keep in step.
   - **No, because the DRM is applied per stream or the file is transformed at install**: then we are back to the stream hash. That is a definition both the fork and Castcade implement identically and version forever, plus a new manifest field, plus a migration whenever it changes. Doable, but it is the expensive path and I would rather confirm it is necessary before either of us builds it.
   - **No, but Table Manager could sign an install manifest** (slug, verified checksum, configVersion, installed-at) that the launcher references: a workable middle ground, but it proves what was installed rather than what was played, so a file replaced after install is not caught. It would need the BASS fix to re-sign the manifest too.
   My guess is yes, since VPX has to parse the OLE container to run the table, but I don't know where in your pipeline the decryption sits or whether the plaintext ever exists as a whole file.
2. Does the WebSocket broadcast include `sig`?
3. Is a per-install `machine_id` acceptable from a privacy standpoint? Arcaid binds it only to the pairing the player made.
4. Which fields in section 4 are already in hand in the ScoreServer, and which would be new reads?
5. What did you find on the integrity side? If the fork can attest to something at runtime beyond this list, a field in the signed record is the easiest way for me to use it.
