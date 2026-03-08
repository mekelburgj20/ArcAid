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

function writeToFile(prefix: string, message: string, ...args: any[]) {
    try {
        const timestamp = new Date().toISOString();
        let formattedArgs = '';
        if (args.length > 0) {
            formattedArgs = ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
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
