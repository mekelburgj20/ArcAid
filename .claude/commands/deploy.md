Production deployment checklist for ArcAid.

1. **Update documentation:**
   - Run `/update-docs` to ensure all docs reflect the current state of the app

2. **Verify local build and tests:**
   - Run `npm run build` (backend TypeScript)
   - Run `cd admin-ui && npm run build` (frontend)
   - Run `npm test` (all tests must pass)
   - All three must complete without errors

3. **Commit and push to main:**
   - Run `git status` to review outstanding changes
   - Stage and commit all changes with a descriptive message
   - `git push origin main`

4. **Wait for GitHub Actions:**
   - Push to main triggers the CI/CD pipeline automatically
   - Monitor the run: `gh run list --limit 1`
   - Wait for the run to complete successfully: `gh run watch`
   - If `gh` is not available, direct the user to https://github.com/mekelburgj20/ArcAid/actions

5. **Verify deployment:**
   - Test public scoreboard: https://arcaid.app/arcaid_demo/
   - Test admin login: https://arcaid.app/login

If the deploy fails or you need to troubleshoot on the server:
```
ssh -i ~/.ssh/id_arcaid root@arcaid
docker logs arcaid --tail 50
```
