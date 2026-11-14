/**
 * Arcaid Witness release signing (W100, ADR 0040).
 *
 * Signs a cabinet build for the self-update channel, or checks a signature.
 * The signature is Ed25519 (RFC 8032 pure) over
 *
 *     ASCII "AW1 " + version + "\n"  ||  the exact ELF bytes
 *
 * printed as standard base64 (88 characters) and written beside the ELF as
 * `<elf>.sig`. Upload the ELF, the version and that signature at Super Admin
 * -> Witness releases; the server verifies it with the same public key the
 * cabinet app has compiled in.
 *
 * Usage:
 *   npm run witness-release -- sign   --elf <path> --version <x.y.z> [--key <pem>]
 *   npm run witness-release -- verify --elf <path> --version <x.y.z> [--sig <base64 | file>]
 *   npm run witness-release -- --help
 *
 * THE PRIVATE KEY IS NEVER PRINTED. It is read from `--key` (default
 * ~/.arcaid-witness/release-signing-key.pem, PKCS#8 PEM) only to sign, and no
 * message this tool prints carries any of its contents. Keep a backup of it
 * outside this PC: losing it ends automatic updates for every installed
 * cabinet until a build with a new public key is installed by hand.
 *
 * Node built-ins only (plus the shared signature module in src/utils).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    WITNESS_RELEASE_PUBLIC_KEY_HEX,
    isElf,
    releaseSignedMessage,
    verifyReleaseSignature,
} from '../src/utils/witnessReleaseSignature.js';
import { isReleaseVersion } from '../src/utils/witnessVersion.js';

/** Raised for user-facing failures — printed without a stack trace. */
class CliError extends Error {}

const DEFAULT_KEY = path.join(os.homedir(), '.arcaid-witness', 'release-signing-key.pem');

const HELP = `
witness-release — sign an Arcaid Witness cabinet build, or check a signature.

Usage:
  npm run witness-release -- sign   --elf <path> --version <x.y.z> [--key <pem>]
  npm run witness-release -- verify --elf <path> --version <x.y.z> [--sig <base64 | file>]

sign
  Signs "AW1 <version>\\n" + the ELF with the release key, checks the result
  against the public key baked into the server and the cabinet app, prints the
  base64 signature and writes it to <elf>.sig.
  --key defaults to ${DEFAULT_KEY} (PKCS#8 PEM). The key is never printed.

verify
  Checks a signature against the baked public key. --sig is the base64 text or
  a path to a file holding it; it defaults to <elf>.sig.

The version must be a dotted-numeric triple (1.1.0) and must be the version the
build reports, or the cabinet will never install it.
`.trim();

interface Flags {
    elf?: string;
    version?: string;
    key?: string;
    sig?: string;
    help: boolean;
}

function parseArgs(argv: string[]): { command: string | undefined; flags: Flags } {
    const flags: Flags = { help: false };
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--help' || arg === '-h') { flags.help = true; continue; }
        const eq = /^--([a-z]+)=(.*)$/s.exec(arg);
        let name: string;
        let value: string | undefined;
        if (eq) {
            name = eq[1]!;
            value = eq[2]!;
        } else if (arg.startsWith('--')) {
            name = arg.slice(2);
            value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) throw new CliError(`Missing value for --${name}`);
            i++;
        } else {
            positional.push(arg);
            continue;
        }
        switch (name) {
            case 'elf': flags.elf = value; break;
            case 'version': flags.version = value; break;
            case 'key': flags.key = value; break;
            case 'sig': flags.sig = value; break;
            default: throw new CliError(`Unknown flag --${name}. Run --help for usage.`);
        }
    }
    return { command: positional[0], flags };
}

function requireVersion(flags: Flags): string {
    const version = (flags.version ?? '').trim();
    if (!version) throw new CliError('--version is required (for example --version 1.1.0).');
    if (!isReleaseVersion(version)) {
        throw new CliError(`"${version}" is not a release version: use a dotted-numeric triple such as 1.1.0 (no suffix, no leading zeros).`);
    }
    return version;
}

function readElf(flags: Flags): { elfPath: string; elf: Buffer } {
    if (!flags.elf) throw new CliError('--elf is required.');
    const elfPath = path.resolve(process.cwd(), flags.elf);
    if (!fs.existsSync(elfPath)) throw new CliError(`ELF not found at ${elfPath}.`);
    const elf = fs.readFileSync(elfPath);
    if (!isElf(elf)) throw new CliError(`${elfPath} is not an ELF executable (it does not start with \\x7fELF).`);
    return { elfPath, elf };
}

/** The private key as a KeyObject. Any failure is reported WITHOUT the file's contents. */
function loadPrivateKey(keyPath: string): crypto.KeyObject {
    if (!fs.existsSync(keyPath)) throw new CliError(`No signing key at ${keyPath} (pass --key).`);
    let key: crypto.KeyObject;
    try {
        key = crypto.createPrivateKey({ key: fs.readFileSync(keyPath), format: 'pem' });
    } catch {
        throw new CliError(`Could not read the signing key at ${keyPath}: expected a PKCS#8 PEM private key.`);
    }
    if (key.asymmetricKeyType !== 'ed25519') {
        throw new CliError(`The key at ${keyPath} is not an Ed25519 key.`);
    }
    return key;
}

/** The raw public half (hex) of a private key. Only the PUBLIC key is ever derived or shown. */
function publicHexOf(privateKey: crypto.KeyObject): string {
    const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' }) as { x?: string };
    return Buffer.from(jwk.x ?? '', 'base64url').toString('hex');
}

function cmdSign(flags: Flags): void {
    const version = requireVersion(flags);
    const { elfPath, elf } = readElf(flags);
    const keyPath = path.resolve(flags.key ?? DEFAULT_KEY);
    const privateKey = loadPrivateKey(keyPath);

    const pub = publicHexOf(privateKey);
    if (pub !== WITNESS_RELEASE_PUBLIC_KEY_HEX) {
        throw new CliError(
            `The key at ${keyPath} is not the release key: its public half is ${pub}, ` +
            `the server and the cabinet app expect ${WITNESS_RELEASE_PUBLIC_KEY_HEX}. Nothing was signed.`,
        );
    }

    const sig = crypto.sign(null, releaseSignedMessage(version, elf), privateKey).toString('base64');
    if (!verifyReleaseSignature(version, elf, sig)) {
        throw new CliError('The new signature does not verify against the baked public key. Nothing was written.');
    }
    const sigPath = `${elfPath}.sig`;
    fs.writeFileSync(sigPath, `${sig}\n`);
    const sha256 = crypto.createHash('sha256').update(elf).digest('hex');
    console.log(sig);
    console.error(`Signed ${path.basename(elfPath)} as version ${version} (${elf.length} bytes, sha256 ${sha256}).`);
    console.error(`Signature written to ${sigPath}.`);
}

function cmdVerify(flags: Flags): void {
    const version = requireVersion(flags);
    const { elfPath, elf } = readElf(flags);
    const source = flags.sig ?? `${elfPath}.sig`;
    let sig = source;
    if (fs.existsSync(source) && fs.statSync(source).isFile()) {
        sig = fs.readFileSync(source, 'utf8');
    } else if (flags.sig === undefined) {
        throw new CliError(`No --sig given and no ${source} found.`);
    }
    if (verifyReleaseSignature(version, elf, sig)) {
        console.log(`OK: the signature verifies for ${path.basename(elfPath)} as version ${version}.`);
        return;
    }
    throw new CliError(`FAILED: the signature does not verify for ${path.basename(elfPath)} as version ${version}.`);
}

function main(): void {
    const { command, flags } = parseArgs(process.argv.slice(2));
    if (!command || flags.help) {
        console.log(HELP);
        return;
    }
    switch (command) {
        case 'sign': cmdSign(flags); break;
        case 'verify': cmdVerify(flags); break;
        default: throw new CliError(`Unknown command "${command}". Run --help for usage.`);
    }
}

try {
    main();
} catch (err) {
    if (err instanceof CliError) {
        console.error(`Error: ${err.message}`);
    } else {
        // Never a stack that could carry key material: only the error's class.
        console.error(`Unexpected error (${err instanceof Error ? err.name : 'unknown'}).`);
    }
    process.exitCode = 1;
}
