Production deployment checklist for ArcAid.

> **Note:** `/wrap` at the end of the session keeps `WORK.md` and the docs in sync; `/release-docs <version>` after the deploy is verified writes the CHANGELOG entry. Neither is a pre-deploy step.

1. **Verify local build and tests:**
   - Run `npm run build` (backend TypeScript)
   - Run `cd admin-ui && npm run build` (frontend)
   - Run `npm test` (all tests must pass)
   - All three must complete without errors

2. **Commit and push to main:**
   - Run `git status` to review outstanding changes
   - Stage and commit all changes with a descriptive message
   - `git push origin main`
   - **Hotfix the owner asked to "skip the CI tests" on:** put `[skip tests]` in the commit message. The workflow skips its `test` job and deploys straight away (the Docker build still compiles). Never `[skip ci]` for this — that skips the deploy itself.

3. **Wait for GitHub Actions:**
   - Push to main triggers the CI/CD pipeline automatically
   - Try `gh run list --limit 1` to check status. If `gh` works, use `gh run watch` to wait for completion.
   - If `gh` fails (not authenticated), direct the user to monitor at: https://github.com/mekelburgj20/ArcAid/actions

4. **Verify deployment:**
   - SSH into the server and confirm healthy startup:
     ```
     ssh arcaid "docker logs arcaid --tail 10"
     ```
   - Look for: `ScoreSyncPoller: starting`, `WebSocket client connected`, no error lines
   - If the user is testing a specific page, optionally verify the API responds:
     ```
     ssh arcaid "docker exec arcaid node -e \"const http=require('http');http.get('http://localhost:3001/api/status',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))})\""
     ```

If the deploy fails or you need to troubleshoot on the server:
```
ssh arcaid
docker logs arcaid --tail 50
docker compose pull && docker compose up -d --force-recreate
```
