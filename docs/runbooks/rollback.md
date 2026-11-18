# Runbook: Roll back a deploy

Use this when a deploy made prod worse and a forward fix is not minutes away. It covers the two
cases that matter, because they are very different:

- **Code only**: the new build is bad but its migrations were harmless (or it had none). Go back to
  the previous image. Nothing is lost.
- **Code + schema**: a migration damaged or wrongly changed data. Go back to the previous image
  **and** to the database as it was just before that deploy. Everything written after the snapshot
  (scores, joins, settings) is lost. That is the trade; decide before you start.

To restore from a nightly backup instead (older than the last deploy, or assets too), use
[`restore.md`](restore.md).

## What exists

- **Every deploy pushes two image tags** to ghcr: `latest` and `sha-<full commit>`
  (`.github/workflows/deploy.yml`). The `sha-` tags are what make a code rollback possible.
- **Every deploy takes a database snapshot first** (X1): `deploy.yml` runs
  `tools/pre-deploy-snapshot.cjs` inside the running container just before it is replaced. The
  file is `pre-deploy/pre-deploy-<UTC time>.db` in the data volume, a complete standalone copy
  (`VACUUM INTO`, no `-wal` / `-shm`). The newest 20 are kept. A deploy whose snapshot fails stops
  before it touches prod.
- The deploy log prints the snapshot's name and size (`pre-deploy snapshot: ...`).

## 0. Find what to go back to

```bash
git log --oneline -5 main                      # the commit BEFORE the bad one
GITHUB_TOKEN= gh run list --workflow deploy.yml --limit 5

ssh arcaid
cd /opt/arcaid
V=/var/lib/docker/volumes/arcaid_arcaid-data/_data
ls -lt "$V/pre-deploy" | head                  # newest first; pick the one taken by the BAD deploy
```

The snapshot taken by the bad deploy is the database as the previous build left it. Its UTC time
is a few seconds before that deploy's container start.

## 1. Code only

With `ARCAID_TAG` in the server's compose file (in place since 2026-11-18, see the last section):

```bash
ARCAID_TAG=sha-<previous full commit> docker compose up -d --force-recreate
```

Without it (a compose file whose image line says a bare `:latest`), point `latest` at the old image locally:

```bash
docker pull ghcr.io/mekelburgj20/arcaid:sha-<previous full commit>
docker tag  ghcr.io/mekelburgj20/arcaid:sha-<previous full commit> ghcr.io/mekelburgj20/arcaid:latest
docker compose up -d --force-recreate          # no `pull`: it would fetch the bad build again
```

## 2. Code + schema

```bash
docker compose stop arcaid
cp -p "$V/arcaid.db" "$V/arcaid.db.pre-rollback"            # keep what you are replacing
cp -p "$V/pre-deploy/pre-deploy-<UTC time>.db" "$V/arcaid.db"
rm -f "$V/arcaid.db-wal" "$V/arcaid.db-shm"                 # a stale WAL would shadow the restored file
chown 999:999 "$V/arcaid.db"                                # the app runs as uid 999; root-owned = SQLITE_READONLY at boot
```

Then start the previous image exactly as in step 1.

## 3. Confirm

```bash
curl -s https://arcaid.app/api/version         # commit = the previous one
docker logs arcaid --tail 50                   # no restart loop, no SQLITE_READONLY
```

## 4. Stop it happening again

The next push to `main` deploys `main` again, bad commit included. Revert it (or fix it) on `main`
before anything else merges. After a schema rollback, tell the rooms that were active what was
lost; `arcaid.db.pre-rollback` still holds the rows written after the snapshot if any need to be
re-entered by hand.

## When the snapshot itself fails

A deploy stops with `pre-deploy snapshot FAILED: <reason>` and prod stays on the old build. Usual
causes: the disk is full, or the data folder is not writable by the app user. Fix the cause and
re-run the deploy. Only if the snapshot is what is broken and the deploy cannot wait: Actions ->
Deploy to Hetzner -> Run workflow -> tick **skip_snapshot**. That deploy has no file to roll a
migration back to.

A container that is not running (prod is already down) is deployed without a snapshot, so a repair
is never blocked.

## The `ARCAID_TAG` line on the server (done 2026-11-18, X1.1)

`/opt/arcaid/docker-compose.yml` is hand-maintained on the server. Its image line (line 10) is:

```yaml
image: ghcr.io/mekelburgj20/arcaid:${ARCAID_TAG:-latest}
```

Nothing changes for a normal deploy (`ARCAID_TAG` is unset, so it is `latest`). It only makes the
one-line rollback in step 1 possible. Check it with `docker compose config | grep image:` (run in
`/opt/arcaid`). The file as it was before the change is beside it:
`docker-compose.yml.bak-x1.1-20261118T034142Z`.
