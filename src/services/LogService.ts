import fs from 'fs';
import path from 'path';

const LOG_PATH = path.join(process.cwd(), 'data', 'arcaid.log');

export class LogService {
    /**
     * Returns the last N lines of the log file.
     */
    static getRecentLogs(maxLines: number = 200): string {
        if (!fs.existsSync(LOG_PATH)) {
            return 'No logs found yet.';
        }

        const content = fs.readFileSync(LOG_PATH, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        return lines.slice(-maxLines).join('\n');
    }
}
