# Runbook: Restore from Backup (multi-tenant)

This procedure restores Arcaid's SQLite database **and** the `data/` asset
subdirectories from a backup produced by `BackupManager` (S9 layout). It is
multi-tenant-safe: it does **not** recreate iScored games or assume a single
env-level iScored account. After restart, normal background reconciliation
(`ScoreSyncPoller` / `TournamentEngine`) brings each room's iScored state back in
line with the restored DB.

## What a backup contains

```
backups/2026-06-18T03-00-00-000Z/
  arcaid.db                 # WAL-safe standalone DB (VACUUM INTO; fully checkpointed, no -wal/-shm)
  backup_metadata.json      # { timestamp, iscoredCaptured, games: [...] }
  data/
    score-photos/           # (if present)
    styles/                 # (if present)
    catalogue-images/       # (if present)
    iscored-styles/         # (if present)
```

Asset subdirs may be absent in a fresh-install backup — restore simply skips any
that are missing.

## Safety properties

- **Integrity-checked before any write.** `restoreBackup` runs
  `PRAGMA integrity_check` against the backup's `arcaid.db` (read-only) and
  **aborts if the result is not `ok`** — the live DB is never touched on a bad
  backup.
- **Pre-restore safety copy.** Immediately before overwriting, the current live
  DB is copied to `<db>.pre-restore` (e.g. `data/arcaid.db.pre-restore`). If the
  restore turns out to be wrong, you can recover from this file.
- **Stale WAL cleared.** Any leftover `arcaid.db-wal` / `arcaid.db-shm` next to
  the live DB are deleted so the restored standalone file isn't shadowed by an
  old write-ahead log.

---

## Procedure

### 0. Identify the target DB path

Default is `data/arcaid.db`. If `DB_PATH` is set in the environment, that path
wins. The production container's working directory is the repo root; the DB lives
at `data/arcaid.db` on the mounted volume.

### 1. Stop the app / container

The app holds the SQLite connection in WAL mode. Restoring under a live process
is unsafe.

```bash
# Production (Docker)
docker compose down
# or, to stop only the app container:
docker stop arcaid
```

Confirm nothing is holding the DB:

```bash
docker ps    # arcaid should not be listed as running
```

### 2. Pick a backup

List available backups (newest first), with recursive size including assets:

```bash
npm run restore -- --list
```

Example output:

```
Available backups (newest first):
  2026-06-18T03-00-00-000Z   (42.13 MB, created 2026-06-18T03:00:00.000Z)
  2026-06-17T03-00-00-000Z   (41.98 MB, created 2026-06-17T03:00:00.000Z)
```

### 3. (Recommended) Verify the backup first — no changes made

```bash
npm run restore -- --verify 2026-06-18T03-00-00-000Z
```

Expect `OK: backup "..." passed integrity_check.` If it fails, pick an earlier
backup; do not proceed.

### 4. Run the restore

```bash
npm run restore -- 2026-06-18T03-00-00-000Z
```

The CLI re-runs the integrity check, prints the DANGER ZONE warning, and waits
for you to type `yes`. On confirmation it:

1. verifies the backup (`integrity_check` must be `ok`),
2. writes the pre-restore safety copy `<db>.pre-restore`,
3. removes stale `-wal` / `-shm` sidecars,
4. copies the backup's `arcaid.db` over the live DB,
5. restores each present `data/<subdir>` back into `data/<subdir>`.

> The restore must run **on the host that owns the live `data/` volume**. In
> Docker, run it from a one-off container that mounts the same volume, or run it
> on the host against the bind-mounted path. The container does not need to be
> running during the restore — only the `data/` and `backups/` paths must be
> reachable.

Example (host has the volume bind-mounted at the repo root):

```bash
docker compose down
npm run restore -- 2026-06-18T03-00-00-000Z
docker compose up -d --build
```

### 5. Verify the restored live DB

After copying, confirm the live DB itself passes an integrity check. Inside the
running container there is **no `sqlite3` binary** — use the bundled Node driver:

```bash
docker exec arcaid node -e "const sqlite3=require('sqlite3');const {open}=require('sqlite');(async()=>{const db=await open({filename:process.env.DB_PATH||'./data/arcaid.db',driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});const r=await db.all('PRAGMA integrity_check');console.log(r);await db.close();})().catch(e=>{console.error(e);process.exit(1);});"
```

Expect `[ { integrity_check: 'ok' } ]`.

### 6. Restart and validate

```bash
docker compose up -d --build
docker logs arcaid --tail 50    # confirm boot, no restart loop
```

Validate functionally:

- Log in to the Super Admin UI; confirm rooms, tournaments, and scoreboards load.
- Spot-check one room's scoreboard and a player's score history.
- Confirm assets render: a score photo, a catalogue image, and a style.
- Watch the logs for one `ScoreSyncPoller` cycle — each Discord/iScored-enabled
  room reconciles its own account from its `game_room_settings` credentials. No
  manual iScored rebuild is required.

---

## Recovery (if the restore was wrong)

The previous live DB is at `<db>.pre-restore`. Stop the app and copy it back:

```bash
docker compose down
cp data/arcaid.db.pre-restore data/arcaid.db
rm -f data/arcaid.db-wal data/arcaid.db-shm
docker compose up -d --build
```

(Asset directories are overwritten in place during restore. If you also need the
prior assets back, restore them from a known-good backup using step 4 against
that backup, or from your own out-of-band copy.)

## Notes

- `restoreBackup` does not start iScored sessions or mutate any iScored room.
  iScored game ids are **not** recreated. The restored DB is the source of truth;
  reconciliation is the poller's job on the next cycles.
- Keep at least one earlier verified backup before restoring, in case the chosen
  artifact is itself corrupt.
