import { CronExpressionParser } from 'cron-parser';

/**
 * Returns the next run time for a cron expression in the given timezone.
 * Handles the custom 'L' (last day of month) marker used by the Scheduler.
 */
/**
 * `from` (v2.125.1) is the reference instant — defaults to now. Callers that
 * render a countdown against an injected clock must pass it, or the "next
 * fire" is computed from the real clock while the remaining time is not.
 */
export function getNextRunTime(cronExpr: string, timezone: string, from?: Date): Date | null {
    try {
        const parts = cronExpr.split(' ');
        if (parts[2] === 'L') {
            // Replace 'L' with the actual last day of the current month
            const now = from ?? new Date();
            const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            parts[2] = String(lastDay);
        }

        const resolved = parts.join(' ');
        const parsed = CronExpressionParser.parse(resolved, from ? { tz: timezone, currentDate: from } : { tz: timezone });
        return parsed.next().toDate();
    } catch {
        return null;
    }
}
