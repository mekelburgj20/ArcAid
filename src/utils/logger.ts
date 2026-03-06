import fs from 'fs';
import path from 'path';

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

const CURRENT_LOG_LEVEL = (process.env.LOG_LEVEL?.toUpperCase() as keyof typeof LogLevel) || 'INFO';
const level = LogLevel[CURRENT_LOG_LEVEL as keyof typeof LogLevel] ?? LogLevel.INFO;

const logFilePath = path.join(process.cwd(), 'data', 'arcaid.log');

function writeToFile(prefix: string, message: string, ...args: any[]) {
    try {
        const dir = path.dirname(logFilePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        const timestamp = new Date().toISOString();
        let formattedArgs = '';
        if (args.length > 0) {
             formattedArgs = ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        }
        
        const logLine = `[${timestamp}] [${prefix}] ${message}${formattedArgs}\n`;
        fs.appendFileSync(logFilePath, logLine);
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
