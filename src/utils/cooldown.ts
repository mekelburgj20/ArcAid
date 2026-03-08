/**
 * In-memory per-user command cooldown tracker.
 * Prevents command spam by enforcing minimum intervals between uses.
 */

const cooldowns = new Map<string, number>();

/**
 * Checks if a user is on cooldown for a specific command.
 * Returns 0 if the user can proceed, or the remaining seconds if on cooldown.
 * Automatically registers the usage if the user is not on cooldown.
 */
export function checkCooldown(userId: string, command: string, cooldownSeconds: number): number {
    const key = `${userId}:${command}`;
    const now = Date.now();
    const lastUsed = cooldowns.get(key);

    if (lastUsed) {
        const elapsed = (now - lastUsed) / 1000;
        if (elapsed < cooldownSeconds) {
            return Math.ceil(cooldownSeconds - elapsed);
        }
    }

    cooldowns.set(key, now);
    return 0;
}

// Periodically clean up expired entries to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    for (const [key, timestamp] of cooldowns) {
        if (now - timestamp > maxAge) {
            cooldowns.delete(key);
        }
    }
}, 60 * 1000);
