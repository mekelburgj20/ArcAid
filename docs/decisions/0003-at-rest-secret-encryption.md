---
status: accepted
date: 2026-04-19
deciders: Justin Mekelburg
supersedes:
superseded-by:
---

# At-rest encryption for sensitive settings

## Context

Through v2.2.x, all values in `settings` and `game_room_settings` were stored as plaintext. That was tolerable when the only secrets were the bot token / JWT secret — both global, set once, never round-tripped through the admin UI. The v2.3.0 change to per-room iScored / Discord configuration made every room admin a writer for credentials they own:

- Per-room `ISCORED_PASSWORD` (one per room, set during onboarding, sent through the admin UI).
- Per-room `DISCORD_*` IDs (less sensitive but operationally cohesive with the iScored creds).
- Future per-key API tokens — OPDB, Twitch (IGDB), and anything else we wire to a third-party service.

Plaintext storage of an iScored password was the load-bearing concern: anyone with read access to `data/arcaid.db` (a server-side backup, a misconfigured volume mount, a compromised image, an accidental commit during DB tooling) could harvest credentials for accounts hosted on iScored.info. That's a third-party exposure on top of any local incident.

Constraints we chose to honor:

- The encryption key must live outside the database so a leaked DB doesn't carry the key. → host environment variable.
- New secrets must require an explicit code change to be encrypted. A typo like `IS_CORED_PASSWORD` should never silently land in plaintext.
- The admin UI must never round-trip ciphertext. The user types a plaintext value, the server encrypts on write, and any subsequent `GET` returns a placeholder, not the cipher.
- Existing plaintext rows must continue to work during the transition; encryption is opt-in per key, with backfill on next write.

## Decision

`src/utils/secrets.ts` provides AES-256-GCM encryption keyed off `SECRETS_KEY`, a 32-byte hex string sourced from `process.env`. The `npm run generate-secrets-key` script mints a fresh key.

The set of encrypted keys is a **deliberate allowlist**:

```ts
export const ENCRYPTED_SETTING_KEYS: ReadonlySet<string> = new Set<string>([
    'ISCORED_PASSWORD',
    'OPDB_API_KEY',
    'TWITCH_CLIENT_SECRET',
]);
export function isEncryptedKey(key: string): boolean {
    return ENCRYPTED_SETTING_KEYS.has(key);
}
```

Adding a new secret requires editing this allowlist — there is no convention-based auto-encryption (e.g. "any key ending in `_PASSWORD`"). A typo never silently lands in plaintext because the typo isn't in the allowlist.

`SettingsService` and `GameRoomSettingsService` consult `isEncryptedKey()` on every read and write:

- **Write:** `storedValue = isEncryptedKey(key) ? encryptSecret(strValue) : strValue`
- **Read:** `decryptSecret(stored)` if encrypted; passthrough otherwise.

Ciphertext is recognized by an `enc:v1:` prefix; legacy plaintext rows are passed through transparently. The first write of an allowlisted key after deploy upgrades the row to ciphertext.

The admin UI **never sees ciphertext**. `GET /admin/settings` and `GET /:roomId/settings` route their responses through `maskEncryptedValues()`, which replaces each encrypted value with the literal string `[ENCRYPTED]`. The UI displays this as a masked field with a "set new value" affordance. The admin enters a new plaintext value to overwrite; absence of an update preserves the existing ciphertext untouched (the route filters out `[ENCRYPTED]` placeholders before calling `saveMany`).

### Key files

- `src/utils/secrets.ts` — `encryptSecret`, `decryptSecret`, `isEncryptedKey`, `ENCRYPTED_SETTING_KEYS`, `maskEncryptedValues`, `loadKey`
- `src/services/SettingsService.ts` — encrypt-on-write / decrypt-on-read in `saveMany` and `getAll`
- `src/services/GameRoomSettingsService.ts` — same pattern, per-room
- `src/api/routes/admin.ts` — calls `maskEncryptedValues` on `GET /admin/settings`
- `src/api/routes/rooms.ts` — same on per-room settings
- `scripts/generate-secrets-key.ts` — `crypto.randomBytes(32).toString('hex')`

## Consequences

- **Easier:** A leaked `arcaid.db` (backup, misconfigured volume, accidental commit) does not expose iScored / OPDB / Twitch credentials. The blast radius shrinks to whatever else is in the DB. Adding a new secret-bearing third-party integration is one allowlist line + one UI field.
- **Harder:** Operations now depends on a `SECRETS_KEY` env var. Losing it makes encrypted columns unrecoverable — there's no key-recovery, no master password, no envelope encryption. Backups of the DB without backups of the key are useless for the encrypted rows. Documented in `releases/v2.3.0/README.md` and the deploy runbook.
- **Locked out:** Convention-based auto-encryption (e.g. "anything matching `*_PASSWORD`") is intentionally rejected. Any pattern-matched scheme is a footgun for typos. The allowlist is the source of truth and code-review-gated.

## Alternatives Considered

- **Convention-based auto-encrypt (e.g., regex on key name).** Rejected. A typo (`IS_CORED_PASSWORD`, `OPDB_TOKEN_API` instead of `OPDB_API_TOKEN`) silently lands in plaintext. The risk is asymmetric — the typo causes a security regression, not a feature regression that surfaces in QA. An allowlist makes the regression impossible.
- **Application-level encryption with the key derived from a per-row salt + master password.** Rejected as overengineering. We don't have a key-rotation requirement yet and the master-password-in-env model is operationally simpler. If we ever need rotation, the `enc:v1:` prefix gives us a versioning hook.
- **Database-level encryption (SQLite encryption extensions like SQLCipher).** Rejected. SQLCipher requires a custom build of the SQLite binding (we use `sqlite3` from npm), encrypts the entire DB file (so any leak still includes everything else), and complicates restore-from-backup tooling. Application-level allowlist gives finer-grained control with a fraction of the operational complexity.
- **OS keychain integration (libsecret, macOS Keychain, Windows Credential Manager).** Rejected. The app runs in a Docker container without access to the host keychain; configuring a separate keystore service per environment is an unnecessary moving part for a single-instance deployment.
- **HashiCorp Vault / AWS KMS / cloud-managed secrets.** Rejected for now. ArcAid is a single-tenant Docker container on a dedicated host. Adding a managed-secrets dependency for ~3 keys is over-spec; if/when we deploy multi-region or multi-tenant, this ADR can be superseded.
