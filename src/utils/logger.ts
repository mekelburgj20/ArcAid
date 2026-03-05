export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

const CURRENT_LOG_LEVEL = (process.env.LOG_LEVEL?.toUpperCase() as keyof typeof LogLevel) || 'INFO';
const level = LogLevel[CURRENT_LOG_LEVEL as keyof typeof LogLevel] ?? LogLevel.INFO;

export function logInfo(message: string, ...args: any[]) {
    if (level <= LogLevel.INFO) {
        console.log(`[INFO] ${message}`, ...args);
    }
}

export function logWarn(message: string, ...args: any[]) {
    if (level <= LogLevel.WARN) {
        console.warn(`[WARN] ${message}`, ...args);
    }
}

export function logError(message: string, ...args: any[]) {
    if (level <= LogLevel.ERROR) {
        console.error(`[ERROR] ${message}`, ...args);
    }
}

export function logDebug(message: string, ...args: any[]) {
    if (level <= LogLevel.DEBUG) {
        console.debug(`[DEBUG] ${message}`, ...args);
    }
}
