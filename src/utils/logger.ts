import path from 'path';
import { createStream } from 'rotating-file-stream';
import type { RotatingFileStream } from 'rotating-file-stream';

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

const CURRENT_LOG_LEVEL = (process.env.LOG_LEVEL?.toUpperCase() as keyof typeof LogLevel) || 'INFO';
const level = LogLevel[CURRENT_LOG_LEVEL as keyof typeof LogLevel] ?? LogLevel.INFO;

const logDir = path.join(process.cwd(), 'data');

// Rotating file stream: max 10MB per file, keep last 5 rotated files
let logStream: RotatingFileStream | null = null;

function getLogStream(): RotatingFileStream {
    if (!logStream) {
        logStream = createStream('arcaid.log', {
            path: logDir,
            size: '10M',
            interval: '1d',
            maxFiles: 5,
            compress: false
        });
        logStream.on('error', (err) => {
            console.error('Log stream error:', err);
        });
    }
    return logStream;
}

/**
 * Serialize a single log argument for the file stream.
 *
 * v2.4.16: Error instances were stringifying to `{}` because their `message`
 * and `stack` are non-enumerable — so `logError('OPDB sync failed:', err)`
 * wrote a useless empty object to the rotating file. Console output was fine
 * (Node's util.inspect handles Error specially), but the admin Logs viewer
 * reads the file and lost every error detail.
 *
 * Error → "name: message\nstack". JSON.stringify everything else, with a
 * fallback to String() for anything that throws on serialization (cyclic
 * objects etc.).
 */
function formatLogArg(value: unknown): string {
    if (value instanceof Error) {
        const stack = value.stack ?? '';
        return stack ? stack : `${value.name}: ${value.message}`;
    }
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

function writeToFile(prefix: string, message: string, ...args: any[]) {
    try {
        const timestamp = new Date().toISOString();
        let formattedArgs = '';
        if (args.length > 0) {
            formattedArgs = ' ' + args.map(formatLogArg).join(' ');
        }

        const logLine = `[${timestamp}] [${prefix}] ${message}${formattedArgs}\n`;
        // Async write via stream — non-blocking
        getLogStream().write(logLine);
    } catch (e) {
        console.error("Failed to write to log file:", e);
    }
}

export function logInfo(message: string, ...args: any[]) {
    if (level <= LogLevel.INFO) {
        console.log(`[INFO] ${message}`, ...args);
        writeToFile('INFO', message, ...args);
    }
}

export function logWarn(message: string, ...args: any[]) {
    if (level <= LogLevel.WARN) {
        console.warn(`[WARN] ${message}`, ...args);
        writeToFile('WARN', message, ...args);
    }
}

export function logError(message: string, ...args: any[]) {
    if (level <= LogLevel.ERROR) {
        console.error(`[ERROR] ${message}`, ...args);
        writeToFile('ERROR', message, ...args);
    }
}

export function logDebug(message: string, ...args: any[]) {
    if (level <= LogLevel.DEBUG) {
        console.debug(`[DEBUG] ${message}`, ...args);
        writeToFile('DEBUG', message, ...args);
    }
}
