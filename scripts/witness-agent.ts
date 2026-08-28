/**
 * Arcaid Witness PC agent.
 *
 * Drives an AtGames Legends Micro cabinet over adb to (re)provision the
 * "Arcaid Witness" headless daemon — an on-cabinet app that reports table
 * launch/exit times to arcaid.app for P8 verify-join (see docs/decisions,
 * ADR 0020). The cabinet's /tmp is RAM: every power cycle wipes the daemon,
 * the ELF, and the pairing token, so this tool makes re-provisioning a
 * one-command operation. It also pairs a cabinet to an Arcaid account.
 *
 * Usage:
 *   npm run witness-agent -- <command> [flags]
 *   npm run witness-agent -- --help
 *
 * Zero third-party dependencies — Node built-ins + global fetch only.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

interface DeviceEntry {
    ip: string;
    token: string;
    label: string;
}

interface AgentConfig {
    lastDeviceId?: string;
    devices: Record<string, DeviceEntry>;
}

interface Flags {
    ip?: string;
    deviceId?: string;
    server: string;
    adb: string;
    elf: string;
    dryRun: boolean;
    tail: number;
    scrub: boolean;
    label?: string;
    import?: string;
    help: boolean;
}

interface AdbResult {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

const DEFAULT_SERVER = 'https://arcaid.app';
const DEFAULT_ADB = 'adb';
const DEFAULT_PORT = '5555';
const DEFAULT_TAIL = 20;
const DEFAULT_ELF = path.join(
    'tmp', 'witness-build', 'sdk-external-apps-0.3.0', 'dist', 'external', 'arcaid-witness', 'arcaid-witness.elf'
);

const PAIRING_CODE_ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

// busybox-safe env scrape: /proc/<pid>/environ is NUL-separated, not
// newline-separated, so `tr` converts before grep can match line-anchored.
const DISCOVER_DEVICE_ID_CMD =
    "for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null; done | grep -m1 '^ATGAMES_UNIQUE_ID='";

/** Raised for user-facing failures — printed without a stack trace. */
class CliError extends Error {}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const GENERAL_HELP = `
Arcaid Witness PC agent — provisions and manages the Arcaid Witness headless
daemon on an AtGames Legends Micro cabinet over adb.

Usage:
  npm run witness-agent -- <command> [flags]

Commands:
  pair      Pair the cabinet to your Arcaid account (obtains a device token).
  start     Push the ELF + token and launch the headless daemon.
  stop      Stop the daemon (--scrub to also wipe the device-side files).
  status    Report whether the daemon is running, and tail its log.
  config    Show or update local config (server, adb path, known devices).

Global flags:
  --ip <addr[:port]>   Cabinet address on the LAN (default port 5555).
  --device-id <id>     Cabinet device id (the ATGAMES_UNIQUE_ID value).
  --server <base>      Arcaid server base URL (default ${DEFAULT_SERVER}).
  --adb <path>         Path to the adb binary (default "adb" on PATH).
  --elf <path>         Local path to arcaid-witness.elf.
  --dry-run            Print every adb/HTTP action without doing anything.
  --help, -h            Show this help (or "<command> --help" for detail).

Typical session:
  npm run witness-agent -- pair --ip 192.168.68.71
  # ... after every cabinet power-on:
  npm run witness-agent -- start

Run "npm run witness-agent -- <command> --help" for command-specific detail.
`.trim();

const PAIR_HELP = `
witness-agent pair — pair a cabinet to your Arcaid account.

Usage:
  npm run witness-agent -- pair [--device-id <id>] [--ip <addr>]
  npm run witness-agent -- pair --import <file> [--device-id <id>]

What it does:
  1. Resolves the cabinet's device id (flag, saved config, on-device
     discovery over adb, or a manual prompt as a last resort).
  2. Prompts for the 6-character pairing code from arcaid.app -> Account
     Settings -> "Arcaid Witness cabinets" -> "Pair a cabinet". Codes expire
     in ~10 minutes.
  3. Calls the Arcaid server to exchange the code for a device token and
     stores it in ~/.arcaid-witness/config.json. The token is never printed.
  4. If --ip is reachable and the daemon dir already exists on the cabinet,
     also pushes the token there immediately; otherwise the next \`start\`
     picks it up.

--import <file>
  Skips the network call entirely and imports an existing token file
  (plain text, whitespace trimmed) — used to migrate a prior manual backup,
  e.g. tmp/witness-build/device-state/witness-token.txt.

Flags:
  --device-id <id>   Skip device-id resolution.
  --ip <addr[:port]> Cabinet address, used for discovery + the best-effort push.
  --server <base>    Arcaid server base URL.
  --dry-run          Show the HTTP request that would be made; no network call,
                      no prompts (placeholders are used instead).
`.trim();

const START_HELP = `
witness-agent start — push the ELF + token and launch the headless daemon.

Usage:
  npm run witness-agent -- start [--device-id <id>] [--ip <addr>] [--elf <path>]

Requires a token already stored for the device (run \`pair\` first) and a
local arcaid-witness.elf (built via the SDK Docker image — see the
tmp/witness-build memory/runbook; pass --elf to point at a build you have).

Steps: connect + verify over adb -> kill any existing daemon (pidfile-only,
busybox has no pkill) -> push the ELF -> push the token -> launch detached
via start-stop-daemon -> verify the pid is alive and show the first lines
of the log.

NEVER launch the app without --headless: the UI app on a Micro wedges the
display stack and requires a power cycle to recover. This command always
launches with --headless — there is no flag to turn that off.

/tmp on the cabinet is RAM: every power cycle wipes the daemon, the ELF, and
the token. Run \`start\` again after every cabinet power-on.

Flags:
  --elf <path>  Local path to arcaid-witness.elf.
  --dry-run     Print every adb command that would run, including the exact
                start-stop-daemon launch line, without executing anything.
`.trim();

const STOP_HELP = `
witness-agent stop — stop the headless daemon.

Usage:
  npm run witness-agent -- stop [--device-id <id>] [--ip <addr>] [--scrub]

Kills the daemon by pidfile (busybox has no pkill) and reports whether
anything was actually running.

--scrub  Also removes /tmp/aw and /tmp/arcaid-witness-token.txt on the
         cabinet. Your locally stored token is untouched — this only clears
         the device-side copy.
`.trim();

const STATUS_HELP = `
witness-agent status — report whether the daemon is running and tail its log.

Usage:
  npm run witness-agent -- status [--device-id <id>] [--ip <addr>] [--tail N]

Heartbeat lines in the log look like: "beat: sessions=2 reported=2 IN-GAME".

Flags:
  --tail N  Number of trailing log lines to show (default ${DEFAULT_TAIL}).
`.trim();

const CONFIG_HELP = `
witness-agent config — show or update local config. Never touches adb.

Usage:
  npm run witness-agent -- config
  npm run witness-agent -- config --device-id <id> --label <text>

With no flags, prints the server default, the adb path, and every known
device (id, ip, label, whether a token is stored). Never prints a token
value.
`.trim();

function commandHelp(command: string): string {
    switch (command) {
        case 'pair': return PAIR_HELP;
        case 'start': return START_HELP;
        case 'stop': return STOP_HELP;
        case 'status': return STATUS_HELP;
        case 'config': return CONFIG_HELP;
        default: return GENERAL_HELP;
    }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function defaultFlags(): Flags {
    return {
        server: DEFAULT_SERVER,
        adb: DEFAULT_ADB,
        elf: DEFAULT_ELF,
        dryRun: false,
        tail: DEFAULT_TAIL,
        scrub: false,
        help: false,
    };
}

function setFlag(flags: Flags, name: string, value: string): void {
    switch (name) {
        case 'ip': flags.ip = value; break;
        case 'device-id': flags.deviceId = value; break;
        case 'server': flags.server = value; break;
        case 'adb': flags.adb = value; break;
        case 'elf': flags.elf = value; break;
        case 'tail': {
            const n = Number.parseInt(value, 10);
            if (!Number.isFinite(n) || n <= 0) throw new CliError(`--tail must be a positive integer, got "${value}"`);
            flags.tail = n;
            break;
        }
        case 'label': flags.label = value; break;
        case 'import': flags.import = value; break;
        default: throw new CliError(`Unknown flag --${name}. Run --help for usage.`);
    }
}

function parseArgs(argv: string[]): { command: string | undefined; flags: Flags } {
    const flags = defaultFlags();
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--help' || arg === '-h') { flags.help = true; continue; }
        if (arg === '--dry-run') { flags.dryRun = true; continue; }
        if (arg === '--scrub') { flags.scrub = true; continue; }

        const eqMatch = /^--([a-z-]+)=(.*)$/s.exec(arg);
        if (eqMatch) {
            setFlag(flags, eqMatch[1]!, eqMatch[2]!);
            continue;
        }

        if (arg.startsWith('--')) {
            const name = arg.slice(2);
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) {
                throw new CliError(`Missing value for --${name}`);
            }
            i++;
            setFlag(flags, name, value);
            continue;
        }

        positional.push(arg);
    }

    return { command: positional[0], flags };
}

// ---------------------------------------------------------------------------
// adb plumbing
// ---------------------------------------------------------------------------

function quoteForDisplay(arg: string): string {
    return /\s/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Runs adb with an ARGS ARRAY, never a shell string. Git Bash / MSYS on
 * Windows mangles paths like /tmp/... when a command passes through a
 * shell; Node's spawn(cmd, argsArray) bypasses the shell entirely and hands
 * adb its arguments verbatim.
 */
function runAdb(adbPath: string, args: string[], opts: { timeoutMs?: number; dryRun?: boolean } = {}): Promise<AdbResult> {
    const timeoutMs = opts.timeoutMs ?? 15000;

    if (opts.dryRun) {
        console.log(`[dry-run] would run: ${adbPath} ${args.map(quoteForDisplay).join(' ')}`);
        return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false });
    }

    return new Promise((resolve) => {
        const child = spawn(adbPath, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);

        child.stdout?.on('data', (d) => { stdout += d.toString(); });
        child.stderr?.on('data', (d) => { stderr += d.toString(); });

        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ code: null, stdout, stderr: `${stderr}\n${(err as Error).message}`, timedOut });
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr, timedOut });
        });
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeIp(ip: string): string {
    return ip.includes(':') ? ip : `${ip}:${DEFAULT_PORT}`;
}

async function connectAndVerify(ip: string, adbPath: string, dryRun: boolean): Promise<void> {
    await runAdb(adbPath, ['connect', ip], { dryRun, timeoutMs: 15000 });

    if (dryRun) {
        console.log(`[dry-run] would run: ${adbPath} -s ${ip} shell echo ok  (verifies the connection)`);
        return;
    }

    const verify = await runAdb(adbPath, ['-s', ip, 'shell', 'echo ok'], { timeoutMs: 15000 });
    if (verify.timedOut || verify.stdout.trim() !== 'ok') {
        throw new CliError(
            `Could not reach the cabinet at ${ip}.\n` +
            `The cabinet's DHCP address may have changed — rescan and pass --ip, ` +
            `and confirm the cabinet is powered on with adb enabled.` +
            (verify.stderr.trim() ? `\nadb said: ${verify.stderr.trim()}` : '')
        );
    }
}

/** Checks aliveness via /proc — the only reliable signal busybox gives us (no pkill/pgrep). */
async function isDaemonAlive(adbPath: string, ip: string): Promise<boolean> {
    const result = await runAdb(
        adbPath,
        ['-s', ip, 'shell', "if [ -f /tmp/aw/pid ] && [ -d /proc/$(cat /tmp/aw/pid) ]; then echo ALIVE; else echo DEAD; fi"],
        { timeoutMs: 15000 }
    );
    return result.stdout.trim() === 'ALIVE';
}

/** Kill by pidfile only — busybox has no pkill. Returns whether anything was found running. */
async function killExistingDaemon(adbPath: string, ip: string, dryRun: boolean): Promise<boolean> {
    if (dryRun) {
        console.log(
            '[dry-run] would check /tmp/aw/pid; if a live process is found, ' +
            'kill $(cat /tmp/aw/pid), wait 1s, then kill -9 if it is still alive ' +
            '(pidfile-only — busybox has no pkill).'
        );
        return false;
    }

    const alive = await isDaemonAlive(adbPath, ip);
    if (!alive) return false;

    await runAdb(adbPath, ['-s', ip, 'shell', 'kill $(cat /tmp/aw/pid) 2>/dev/null'], { timeoutMs: 15000 });
    await sleep(1000);
    if (await isDaemonAlive(adbPath, ip)) {
        await runAdb(adbPath, ['-s', ip, 'shell', 'kill -9 $(cat /tmp/aw/pid) 2>/dev/null'], { timeoutMs: 15000 });
    }
    return true;
}

/**
 * Writes the token to a local temp file and adb-pushes it — never as a
 * shell command-line argument, so it can't leak into adb's own process
 * list or shell history on either side.
 */
async function pushToken(adbPath: string, ip: string, token: string, dryRun: boolean): Promise<void> {
    if (dryRun) {
        console.log(
            '[dry-run] would write the token to a local temp file, adb push it to ' +
            '/tmp/arcaid-witness-token.txt, then delete the temp file. (token redacted)'
        );
        return;
    }

    const tmpFile = path.join(os.tmpdir(), `arcaid-witness-token-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, token, { mode: 0o600 });
    try {
        const push = await runAdb(adbPath, ['-s', ip, 'push', tmpFile, '/tmp/arcaid-witness-token.txt'], { timeoutMs: 30000 });
        if (push.timedOut || push.code !== 0) {
            throw new CliError(`Failed to push the token to the cabinet.\n${(push.stderr || push.stdout).trim()}`);
        }
    } finally {
        fs.rmSync(tmpFile, { force: true });
    }
}

async function discoverDeviceId(adbPath: string, ip: string): Promise<string | null> {
    const result = await runAdb(adbPath, ['-s', ip, 'shell', DISCOVER_DEVICE_ID_CMD], { timeoutMs: 15000 });
    const line = result.stdout.trim();
    if (!line.startsWith('ATGAMES_UNIQUE_ID=')) return null;
    const value = line.slice('ATGAMES_UNIQUE_ID='.length).trim();
    return value || null;
}

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

function getConfigDir(): string {
    return path.join(os.homedir(), '.arcaid-witness');
}

function getConfigPath(): string {
    return path.join(getConfigDir(), 'config.json');
}

function loadConfig(): AgentConfig {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
        return { devices: {} };
    }
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<AgentConfig>;
        return { lastDeviceId: parsed.lastDeviceId, devices: parsed.devices ?? {} };
    } catch (err) {
        throw new CliError(`Could not read config at ${configPath}: ${(err as Error).message}`);
    }
}

function saveConfig(config: AgentConfig): void {
    const dir = getConfigDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function describeDevice(id: string, device: DeviceEntry): string {
    return `${id}${device.label ? ` (${device.label})` : ''}`;
}

/** Resolves a device that must already be configured (start/stop/status/config). */
function resolveDeviceId(flags: Flags, config: AgentConfig): string {
    if (flags.deviceId) return flags.deviceId;
    if (config.lastDeviceId && config.devices[config.lastDeviceId]) return config.lastDeviceId;

    const ids = Object.keys(config.devices);
    if (ids.length === 1) return ids[0]!;
    if (ids.length === 0) {
        throw new CliError('No cabinet is configured yet. Run `pair` first (see --help).');
    }
    throw new CliError(
        `Multiple cabinets are configured — pass --device-id to choose one.\n` +
        `Known devices: ${ids.map((id) => describeDevice(id, config.devices[id]!)).join(', ')}`
    );
}

function resolveIp(flags: Flags, deviceId: string, device: DeviceEntry | undefined): string {
    const ip = flags.ip ? normalizeIp(flags.ip) : device?.ip;
    if (!ip) throw new CliError(`No ip known for device ${deviceId} — pass --ip.`);
    return ip;
}

// ---------------------------------------------------------------------------
// pair
// ---------------------------------------------------------------------------

async function promptForPairingCode(rl: readline.Interface): Promise<string> {
    console.log('Get a pairing code at arcaid.app -> Account Settings -> "Arcaid Witness cabinets" -> "Pair a cabinet".');
    console.log('Codes expire in ~10 minutes.');
    for (;;) {
        const answer = (await rl.question('Enter the 6-character pairing code: ')).trim().toUpperCase();
        if (PAIRING_CODE_ALPHABET.test(answer)) return answer;
        console.log(`"${answer}" isn't a valid code — 6 characters from ABCDEFGHJKMNPQRSTUVWXYZ23456789 (no 0/O/1/I/L). Try again.`);
    }
}

async function resolvePairDeviceId(flags: Flags, config: AgentConfig, rl: readline.Interface | null): Promise<string> {
    if (flags.deviceId) return flags.deviceId;
    if (config.lastDeviceId) return config.lastDeviceId;

    if (flags.dryRun) {
        console.log('[dry-run] no --device-id given — would attempt on-device discovery, then prompt if that fails (using a placeholder id for this preview).');
        return 'DRYRUN-DISCOVERED-ID';
    }

    if (flags.ip) {
        console.log('No --device-id given — attempting on-device discovery over adb...');
        try {
            const ip = normalizeIp(flags.ip);
            await connectAndVerify(ip, flags.adb, false);
            const discovered = await discoverDeviceId(flags.adb, ip);
            if (discovered) {
                console.log(`Discovered device id ${discovered} on the cabinet.`);
                return discovered;
            }
            console.log('Discovery found no ATGAMES_UNIQUE_ID in any process environment — falling back to manual entry.');
        } catch (err) {
            console.log(`Discovery failed (${(err as Error).message}) — falling back to manual entry.`);
        }
    }

    if (!rl) throw new CliError('No device id known and no way to prompt for one (pass --device-id).');
    console.log('Could not determine the device id automatically.');
    console.log('On a 6.x big cab it shows (partly masked) on the Witness app status screen; for a Micro it must be known from a prior pairing.');
    const answer = (await rl.question('Enter the cabinet device id: ')).trim();
    if (!answer) throw new CliError('A device id is required to pair.');
    return answer;
}

function formatPairError(code: string, message: string): string {
    const hints: Record<string, string> = {
        CODE_INVALID: 'Double-check the 6 characters — codes use the alphabet ABCDEFGHJKMNPQRSTUVWXYZ23456789 (no 0/O/1/I/L).',
        CODE_EXPIRED: 'That code expired — mint a fresh one at arcaid.app -> Account Settings -> "Arcaid Witness cabinets" -> "Pair a cabinet".',
        CODE_USED: 'That code was already used — mint a fresh one.',
        DEVICE_CONFLICT: 'This cabinet is already paired to a different Arcaid account — unpair it there first.',
    };
    const hint = hints[code];
    return `Pairing failed: ${message}${hint ? `\n${hint}` : ''}`;
}

/** Best-effort push after a fresh pairing — silently skipped if the cabinet isn't ready. */
async function pushTokenIfDeviceReady(adbPath: string, ip: string, token: string): Promise<void> {
    await connectAndVerify(ip, adbPath, false);
    const dirCheck = await runAdb(adbPath, ['-s', ip, 'shell', '[ -d /tmp/aw ] && echo yes || echo no'], { timeoutMs: 15000 });
    if (dirCheck.stdout.trim() !== 'yes') {
        console.log('(Daemon directory not present on the cabinet yet — run `start` to provision it and push the token.)');
        return;
    }
    await pushToken(adbPath, ip, token, false);
    console.log('Token also pushed to the cabinet.');
}

async function cmdPair(flags: Flags): Promise<void> {
    const config = loadConfig();

    if (flags.import) {
        const deviceId = flags.deviceId ?? config.lastDeviceId;
        if (!deviceId) throw new CliError('`pair --import` needs --device-id (no cabinet configured yet to infer one).');

        if (flags.dryRun) {
            console.log(`[dry-run] would read ${flags.import} and store its contents as the token for device ${deviceId}. (token redacted)`);
            return;
        }

        if (!fs.existsSync(flags.import)) throw new CliError(`${flags.import} does not exist.`);
        const raw = fs.readFileSync(flags.import, 'utf8').trim();
        if (!raw) throw new CliError(`${flags.import} is empty — nothing to import.`);

        const existing = config.devices[deviceId] ?? { ip: '', token: '', label: '' };
        config.devices[deviceId] = {
            ip: flags.ip ? normalizeIp(flags.ip) : existing.ip,
            token: raw,
            label: existing.label,
        };
        config.lastDeviceId = deviceId;
        saveConfig(config);
        console.log(`Imported token for device ${deviceId} from ${flags.import}. (token not shown)`);
        return;
    }

    const rl = flags.dryRun ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const deviceId = await resolvePairDeviceId(flags, config, rl);

        let code: string;
        if (flags.dryRun) {
            code = 'DRYRUN';
            console.log('[dry-run] would prompt for the 6-character pairing code (using placeholder "DRYRUN" for this preview).');
        } else {
            code = await promptForPairingCode(rl!);
        }

        const base = flags.server.replace(/\/+$/, '');
        const url = `${base}/api/witness/pair?code=${encodeURIComponent(code)}&device=${encodeURIComponent(deviceId)}`;

        if (flags.dryRun) {
            console.log(`[dry-run] would GET ${url}`);
            console.log(`[dry-run] on success, would store the returned token in ${getConfigPath()} (never printed).`);
            return;
        }

        console.log(`Requesting a pairing token for device ${deviceId}...`);
        const res = await fetch(url);
        const body = await res.json().catch(() => null) as { ok?: boolean; token?: string; error?: string; code?: string } | null;

        if (res.ok && body?.ok && typeof body.token === 'string') {
            const existing = config.devices[deviceId] ?? { ip: '', token: '', label: '' };
            config.devices[deviceId] = {
                ip: flags.ip ? normalizeIp(flags.ip) : existing.ip,
                token: body.token,
                label: existing.label,
            };
            config.lastDeviceId = deviceId;
            saveConfig(config);
            console.log(`Paired. Device ${deviceId} is ready — token stored (not shown).`);

            if (flags.ip) {
                try {
                    await pushTokenIfDeviceReady(flags.adb, normalizeIp(flags.ip), body.token);
                } catch (err) {
                    console.log(`(Could not reach the cabinet to push the token now: ${(err as Error).message} — it will be pushed on the next \`start\`.)`);
                }
            } else {
                console.log('Run `start` (with --ip if needed) to push the token and launch the daemon.');
            }
        } else {
            throw new CliError(formatPairError(body?.code ?? 'UNKNOWN', body?.error ?? `HTTP ${res.status}`));
        }
    } finally {
        rl?.close();
    }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function cmdStart(flags: Flags): Promise<void> {
    const config = loadConfig();
    const deviceId = resolveDeviceId(flags, config);
    const device = config.devices[deviceId];
    const dryRun = flags.dryRun;

    let token: string;
    if (device?.token) {
        token = device.token;
    } else if (dryRun) {
        token = '<no token stored — dry-run placeholder>';
        console.log(`[dry-run] no token is stored for ${deviceId} yet — using a placeholder for this preview. Run \`pair\` first for a real start.`);
    } else {
        throw new CliError(`No token stored for device ${deviceId}. Run \`pair\` first.`);
    }

    const ip = resolveIp(flags, deviceId, device);

    const elfPath = path.resolve(process.cwd(), flags.elf);
    const elfExists = fs.existsSync(elfPath);
    if (!elfExists) {
        const msg =
            `ELF not found at ${elfPath}.\n` +
            `It's built via the SDK Docker image (see the tmp/witness-build memory/runbook) — pass --elf to point at a build you already have.`;
        if (dryRun) {
            console.log(`[dry-run] note: ${msg}\n(a real \`start\` would fail here unless --elf points elsewhere)`);
        } else {
            throw new CliError(msg);
        }
    }

    console.log(`Connecting to ${deviceId} at ${ip}...`);
    await connectAndVerify(ip, flags.adb, dryRun);

    console.log('Checking for an existing daemon...');
    await killExistingDaemon(flags.adb, ip, dryRun);

    await runAdb(flags.adb, ['-s', ip, 'shell', 'mkdir -p /tmp/aw'], { dryRun, timeoutMs: 15000 });

    console.log(`Pushing ${path.basename(elfPath)}...`);
    const pushElf = await runAdb(flags.adb, ['-s', ip, 'push', elfPath, '/tmp/aw/arcaid-witness.elf'], { dryRun, timeoutMs: 30000 });
    if (!dryRun && (pushElf.timedOut || pushElf.code !== 0)) {
        throw new CliError(`Failed to push the ELF to the cabinet.\n${(pushElf.stderr || pushElf.stdout).trim()}`);
    }
    await runAdb(flags.adb, ['-s', ip, 'shell', 'chmod 755 /tmp/aw/arcaid-witness.elf'], { dryRun, timeoutMs: 15000 });

    console.log('Pushing the pairing token...');
    await pushToken(flags.adb, ip, token, dryRun);

    console.log('Launching the headless daemon...');
    // Proven-on-hardware line (2026-08-28) — do not "improve" the quoting or
    // drop --headless: the UI app wedges the Micro's display stack.
    const launchCmd =
        `export ARCAID_DEVICE_ID=${deviceId}; start-stop-daemon --start --background --make-pidfile --pidfile /tmp/aw/pid ` +
        `--startas /bin/sh -- -c 'exec /tmp/aw/arcaid-witness.elf --headless > /tmp/aw/headless.log 2>&1'`;
    await runAdb(flags.adb, ['-s', ip, 'shell', launchCmd], { dryRun, timeoutMs: 15000 });

    if (dryRun) {
        console.log('[dry-run] would wait ~2s, then verify the pid is alive and print the first lines of /tmp/aw/headless.log.');
        console.log('Dry run complete — nothing was executed on any cabinet.');
        return;
    }

    await sleep(2000);
    const alive = await isDaemonAlive(flags.adb, ip);
    const log = await runAdb(flags.adb, ['-s', ip, 'shell', 'head -n 10 /tmp/aw/headless.log 2>/dev/null'], { timeoutMs: 15000 });

    console.log('--- headless.log (first lines) ---');
    console.log(log.stdout.trim() || '(empty)');
    console.log('-----------------------------------');

    if (log.stdout.includes('no pairing token')) {
        throw new CliError('The daemon reports "no pairing token" — the token push may have failed. Run `pair` again, then `start`.');
    }
    if (log.stdout.includes('no device id')) {
        throw new CliError('The daemon reports "no device id" — check --device-id / ARCAID_DEVICE_ID.');
    }
    if (!alive) {
        throw new CliError('The daemon does not appear to be running after launch. Check the log above.');
    }

    console.log(`Started. Device ${deviceId} is watching.`);
    console.log('Reminder: /tmp is RAM on the cabinet — after any power cycle, run `start` again.');
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

async function cmdStop(flags: Flags): Promise<void> {
    const config = loadConfig();
    const deviceId = resolveDeviceId(flags, config);
    const device = config.devices[deviceId];
    const ip = resolveIp(flags, deviceId, device);

    console.log(`Connecting to ${deviceId} at ${ip}...`);
    await connectAndVerify(ip, flags.adb, flags.dryRun);

    const wasRunning = await killExistingDaemon(flags.adb, ip, flags.dryRun);
    if (!flags.dryRun) {
        console.log(wasRunning ? 'Daemon was running — stopped it.' : 'Daemon was not running.');
    }

    if (flags.scrub) {
        console.log('Scrubbing the device-side daemon dir + token (local config keeps the token)...');
        await runAdb(flags.adb, ['-s', ip, 'shell', 'rm -rf /tmp/aw'], { dryRun: flags.dryRun, timeoutMs: 15000 });
        await runAdb(flags.adb, ['-s', ip, 'shell', 'rm -f /tmp/arcaid-witness-token.txt'], { dryRun: flags.dryRun, timeoutMs: 15000 });
    }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function cmdStatus(flags: Flags): Promise<void> {
    const config = loadConfig();
    const deviceId = resolveDeviceId(flags, config);
    const device = config.devices[deviceId];
    const ip = resolveIp(flags, deviceId, device);

    console.log(`Connecting to ${deviceId} at ${ip}...`);
    await connectAndVerify(ip, flags.adb, flags.dryRun);

    if (flags.dryRun) {
        console.log(`[dry-run] would check /tmp/aw/pid for aliveness and run: tail -n ${flags.tail} /tmp/aw/headless.log`);
        return;
    }

    const alive = await isDaemonAlive(flags.adb, ip);
    console.log(`Daemon: ${alive ? 'RUNNING' : 'not running'}`);

    const log = await runAdb(flags.adb, ['-s', ip, 'shell', `tail -n ${flags.tail} /tmp/aw/headless.log 2>/dev/null`], { timeoutMs: 15000 });
    console.log(`--- headless.log (last ${flags.tail} lines) ---`);
    console.log(log.stdout.trim() || '(empty or missing)');
    console.log('-------------------------------------------');
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function cmdConfig(flags: Flags): void {
    const config = loadConfig();

    if (flags.label !== undefined) {
        const deviceId = resolveDeviceId(flags, config);
        const device = config.devices[deviceId];
        if (!device) throw new CliError(`Device ${deviceId} is not configured yet — run \`pair\` first.`);
        device.label = flags.label;
        saveConfig(config);
        console.log(`Labelled ${deviceId} as "${flags.label}".`);
        return;
    }

    console.log(`Config file: ${getConfigPath()}`);
    console.log(`Server: ${flags.server}`);
    console.log(`adb path: ${flags.adb}`);
    console.log(`Last used device: ${config.lastDeviceId ?? '(none)'}`);

    const ids = Object.keys(config.devices);
    if (ids.length === 0) {
        console.log('No cabinets configured yet. Run `pair` to add one.');
        return;
    }

    console.log('Devices:');
    for (const id of ids) {
        const d = config.devices[id]!;
        console.log(`  ${id}  ip=${d.ip || '(unknown)'}  label=${d.label || '(none)'}  token=${d.token ? '(stored)' : '(none)'}`);
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const { command, flags } = parseArgs(argv);

    if (!command || flags.help) {
        console.log(command ? commandHelp(command) : GENERAL_HELP);
        return;
    }

    switch (command) {
        case 'pair':
            await cmdPair(flags);
            break;
        case 'start':
            await cmdStart(flags);
            break;
        case 'stop':
            await cmdStop(flags);
            break;
        case 'status':
            await cmdStatus(flags);
            break;
        case 'config':
            cmdConfig(flags);
            break;
        default:
            throw new CliError(`Unknown command "${command}". Run --help for usage.`);
    }
}

main().catch((err) => {
    if (err instanceof CliError) {
        console.error(`Error: ${err.message}`);
    } else {
        console.error('Unexpected error:', err instanceof Error ? (err.stack ?? err.message) : err);
    }
    process.exitCode = 1;
});
