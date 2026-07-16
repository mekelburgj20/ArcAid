import webpush from 'web-push';

/**
 * Generates a VAPID keypair for browser Web Push notifications (S15).
 *
 * Unlike SECRETS_KEY these do NOT go in .env — paste both values into the
 * matching fields on the super-admin Global Settings page. The private key is
 * encrypted at rest there (ENCRYPTED_SETTING_KEYS allowlist).
 *
 * Usage:
 *   npm run generate-vapid-keys
 */
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`WEB_PUSH_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`WEB_PUSH_VAPID_PRIVATE_KEY=${privateKey}`);
console.log('');
console.log('# Paste these two values into the matching fields on the');
console.log('# super-admin Global Settings page.');
console.log('# Rotating the pair invalidates every existing browser');
console.log('# subscription — users must re-enable push on each device.');
