import { randomBytes } from 'crypto';

/**
 * Generates a 32-byte key suitable for SECRETS_KEY (AES-256-GCM master key).
 * Prints the base64-encoded value to stdout — caller appends to .env.
 *
 * Usage:
 *   npm run generate-secrets-key
 *   # => SECRETS_KEY=Abc123...base64...
 */
const key = randomBytes(32).toString('base64');
console.log(`SECRETS_KEY=${key}`);
console.log('');
console.log('# Append the line above to your .env file.');
console.log('# Back this value up securely — losing it renders every encrypted');
console.log('# secret in the database unreadable.');
