1. ~~Game Library on Super Admin portal does not need to have a Rating field.~~ DONE — Rating column hidden on super admin view, still visible in room admin context.

2. ~~Super admin portal -> Game Rooms - need to be able to click on Game Room name and be taken to the game room admin portal. Should also be a field for the public scoreboard for the game room which is clickable as well.~~ DONE — Room name links to room admin portal, new Scoreboard column links to public scoreboard (opens in new tab).
   - What other Super Admin Dashboard items should appear here? It'd be great to get server metrics like CPU/MEM I/O and other helpful server / container metrics. (FUTURE)

3. Considerations for resilient/highly available service i.e. multiple containers. What's needed for this?

   **Current Constraints:**
   - **SQLite** — single-file DB, no concurrent writes from multiple processes. Primary blocker.
   - **Singletons** — TournamentEngine, Scheduler, TimeoutManager hold in-memory state. Multiple instances would duplicate cron jobs and maintenance runs.
   - **Playwright sessions** — IScoredClient uses persistent browser sessions stored on local disk.

   **Approaches (ranked by effort):**

   | Approach | Effort | Notes |
   |----------|--------|-------|
   | Active-passive failover | Low | 2 containers, 1 active. Docker restart policy + health checks. Shared volume for SQLite. |
   | Read replicas (Litestream) | Medium | SQLite WAL mode + Litestream replication. One writer, N readers. Public scoreboard (read-heavy) benefits most. |
   | Separate concerns | Medium | (1) Stateless API container (can scale horizontally), (2) Singleton engine/scheduler container. Requires DB change from SQLite. |
   | Migrate to PostgreSQL | High | Unlocks true multi-container with connection pooling. Rewrite all raw SQL + migrations. Biggest payoff, largest effort. |

   **Quick wins (no architecture change):**
   - Docker `restart: always` + health check → auto-recovery
   - Litestream → continuous SQLite backups to S3, point-in-time restore
   - Reverse proxy (nginx/Caddy) → SSL termination, request buffering, edge rate limiting
   - CDN for static admin-ui assets

   **Recommendation:** Start with active-passive + Litestream. Migrate to PostgreSQL when scale demands it.

4. ~~Public users should have a way of seeing the All Time high score for a game.~~ DONE — Added All-Time High column to Game Availability page showing high score + player name per game. Data sourced from all tournament submissions in the room.
   - FUTURE: Filter scores to view just scores from your Discord friends. Requires Discord friends list access (bot needs `relationships.read` intent, which is not available to bots — would need OAuth2 user token flow or a manual friends list feature).
