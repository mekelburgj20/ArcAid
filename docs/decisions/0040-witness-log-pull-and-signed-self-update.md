---
status: accepted
date: 2026-11-13
deciders: owner (request 2026-11-13)
supersedes:
superseded-by:
---

# A cabinet sends its logs when its player asks, and updates itself from a signed release

## Context

Two chores sat between a cabinet problem and its fix. To read a tester's `witness.log` and launcher score files, the
tester pulled the USB stick, copied files by hand and mailed them. To ship a cabinet build, every tester copied four
files onto the stick. Both scale with the number of cabinets, and both fail quietly (the wrong file, a wiped `data/`
folder, a build never installed).

Facts this rests on:

- The cabinet app reaches the server by running the cabinet's own `curl` (`Reporter.cpp`). The "GET only" rule of the
  device routes came from the AtGames SDK's HTTP helper, which the app does not use, so a POST with a file body and a
  binary download are available.
- A cabinet cannot be reached from the server. The only moment the server can speak to it is the answer to a call the
  cabinet makes; the beacon's heartbeat arrives every 120 s.
- The beacon lives in RAM and dies with the power. The firmware starts external apps only from their tile, from the
  ELF on the stick. So a new ELF on the stick is picked up the next time the tile is opened (cabinet 1.0.8's
  stale-beacon replace).
- A scout build once tailed a tester's launcher licence file (name and e-mail) into a harvest. Whatever leaves a
  cabinet must be a list fixed in the app.

## Decision

**Both features ride the heartbeat answer** as two optional fields, `logs` (a request id) and `update` (a version).
Cabinets before 1.1.0 ignore them. Neither can fail the heartbeat.

### Log pull

- **The player starts it** (Account Settings → Arcaid Witness devices → Get logs) and the player downloads the result.
  Until the player sends a ready bundle to Arcaid support ("Send to Arcaid support", with an optional note), nobody
  else can list, download or delete it; the request id alone authorizes nothing. A sent bundle (`shared_at`) can
  also be listed and downloaded by the super-admin; only the player can remove it.
- **The cabinet decides what is in it.** The server sends an id, never a path. The app packs a fixed allow-list (its
  own event log, the launcher journal and log, the per-table score files) into one uncompressed tar with a manifest,
  and uploads it with one POST (`/api/witness/logs`, device-token auth, 16 MiB cap). The token file and any
  licence/key/token file are never read.
- **Lifecycle:** `pending` for 15 minutes, then `expired` (decided on read, no timer); `ready` bundles are deleted
  after 7 days (30 days once sent to support); unpairing a device deletes its bundles. Files live in `data/witness-logs/`.
- The download is the stored tar streamed through gzip.

### Self-update

- **A release is an ELF plus an Ed25519 signature** over `"AW1 <version>\n"` followed by the ELF bytes. The private
  key stays on the owner's PC (`~/.arcaid-witness/release-signing-key.pem`); the public key is compiled into the
  cabinet app and the server. The cabinet installs nothing that does not verify, so a compromised server or a
  tampered download cannot put code on a cabinet. Binding the version into the signed bytes, plus the cabinet's
  "newer than what I run" rule, closes the replay of an old signed build.
- **The server checks the same signature at upload**, so an unsigned or mis-versioned build is refused at the door
  instead of being offered to cabinets that would each download and reject it.
- **Channels are the staged rollout:** a release is `draft` (offered to nobody), `beta` (cabinets whose player ticked
  "Get test builds early") or `stable` (every cabinet with automatic updates on, the default). One pure offer rule
  (`WitnessReleaseService`) answers the heartbeat, both download routes and the devices list.
- **The cabinet never replaces a running beacon.** It downloads only while no table is running and nothing is waiting
  to be sent, verifies, keeps the old ELF as `.prev`, renames the new one into place and reports it as `staged`. The
  new build starts when the tile is next opened.
- **The player can turn it off** per cabinet.

## Consequences

- A cabinet must run 1.1.0 once (one last manual install) before either feature exists for it.
- A request is answered within one heartbeat (up to about 2 minutes) and only while the cabinet is on, online and the
  tile has been opened since power-on. A powered-off cabinet reads `expired`, with words that say what to do.
- **A build that cannot start cannot update itself away.** The firmware runs the stick's ELF; if that crashes, no
  beacon runs and no heartbeat asks for the next release. The remedy is the manual install that exists today. The
  defence is the channel order: a release goes to `beta` (the owner's own cabinet first) before `stable`.
- **Losing the signing key ends automatic updates** for every installed cabinet until a build with a new public key is
  installed by hand. The key needs a backup outside the PC.
- Log bundles are play data and may carry a device id and an account name. They are stored for at most 7 days,
  readable only by their player, or for 30 days by the super-admin once the player chose to send one to Arcaid
  support. There is no support-side pull that skips that choice.
- Castcade (the desktop Witness) is out of scope: it has its own updater and log folder.
- Only the ELF updates. The tile's name, art and controller file still change only by hand.

## Alternatives rejected

- **Chunked GET upload.** Fits the old "GET only" doctrine and nothing else: about a hundred requests per bundle
  through URL length limits. The doctrine's premise does not apply to this app.
- **Server names the files.** Turns the server into a way to read any file a cabinet can; rejected on the licence-file
  precedent.
- **Trust HTTPS alone for updates.** Makes the web server (and anything that can write `data/`) able to run code on
  every cabinet.
- **Re-exec the beacon after download.** Activates sooner, but loses in-memory deferred scores and the open-session
  marker, and cannot be tested without hardware. Deferred until a cabinet proves the plain path.

## Pair by phone and the kit download (v2.247.0, cabinet 1.1.1)

Typing a six-character code on a cabinet with a joystick was the slowest step of a first install, and collecting the
four install files by hand was the other. Both are replaced, and the typed code stays as the fallback.

- **Pair by phone.** "PAIR THIS CABINET" asks the server for a short code and a poll secret
  (`GET /api/witness/pair/start`), shows the code as a QR code for `arcaid.app/pair/<code>`, and polls every 3 seconds
  for up to 10 minutes. The player opens the page on their phone, sees what is being paired (cabinet model, the end
  of the device id, the AtGames name), and approves it.
- **The pairing is performed at poll time, not at approval.** Approval only records who approved. The cabinet's next
  poll claims the request, runs the same pairing rules as the typed code again (`DEVICE_CONFLICT`, `DEVICE_LIMIT`),
  writes the device row through the same code, and returns the token in that one answer. So the plaintext token is
  never stored anywhere, not even for the seconds between approval and the poll, and a second poll gets nothing.
  The poll secret is stored only as its SHA-256; an unknown, expired, used or wrong-secret poll gets one `410`.
- **The known risk.** A player who approves a code someone else sent them pairs that person's cabinet to their own
  account (the device-flow phishing pattern). Nothing on the server can tell the two apart, so the page must show
  what is being paired and tell the player to approve only a code on the cabinet in front of them. The damage is
  bounded: the cabinet's scores go to the wrong account, the real owner sees "PAIRED TO <account>" on the cabinet
  screen, unpairing ends it, and the W97 caps still apply.
- **The kit download.** Account Settings offers one zip with the app ELF and the tile's three static files (art,
  description XML, controller map), committed at `witness-kit/`. The ELF is only ever the highest `stable` release,
  whatever the player's "Get test builds early" switch says: a manual install is the recovery path, so it gets the
  build that every cabinet already runs, never a beta or a draft.
