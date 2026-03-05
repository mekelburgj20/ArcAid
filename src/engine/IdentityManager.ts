import { Guild } from 'discord.js';
import { getDatabase } from '../database/database.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { IScoredClient } from './IScoredClient.js';

export class IdentityManager {
    private static instance: IdentityManager;

    private constructor() {}

    public static getInstance(): IdentityManager {
        if (!IdentityManager.instance) {
            IdentityManager.instance = new IdentityManager();
        }
        return IdentityManager.instance;
    }

    /**
     * Scrapes active games and attempts to auto-map unmapped iScored users
     * to Discord members based on name matching.
     */
    public async reconcileMappings(guild: Guild, client: IScoredClient): Promise<void> {
        logInfo('🔍 Starting proactive identity mapping scrape...');
        const db = await getDatabase();

        try {
            // 1. Get active games (Requires a query against games table)
            const activeGames = await db.all("SELECT id, iscored_id, name FROM games WHERE status = 'ACTIVE'");
            if (activeGames.length === 0) {
                logInfo('   -> No active games to scrape for identity mapping.');
                return;
            }

            const allUsernames = new Set<string>();

            // 2. We need the public URL to scrape. Assuming it's in env.
            const publicUrl = process.env.ISCORED_PUBLIC_URL;
            if (!publicUrl) {
                logWarn('⚠️ ISCORED_PUBLIC_URL not set. Cannot scrape public scores for identity mapping.');
                return;
            }

            // Scrape each active game
            for (const game of activeGames) {
                if (!game.iscored_id) continue;
                const scores = await client.scrapePublicScores(publicUrl, game.iscored_id);
                scores.forEach((s: any) => allUsernames.add(s.name));
            }

            const uniqueUsernames = Array.from(allUsernames);
            
            // 3. Find which ones are unmapped
            const unmappedNames: string[] = [];
            for (const name of uniqueUsernames) {
                const row = await db.get('SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)', name);
                if (!row) unmappedNames.push(name);
            }

            if (unmappedNames.length === 0) {
                logInfo('   -> All active users are already mapped.');
                return;
            }

            logInfo(`   -> Attempting to auto-map ${unmappedNames.length} users: ${unmappedNames.join(', ')}`);

            try {
                await guild.members.fetch();
            } catch (e) {
                logWarn('   -> Failed to fetch all members (Intent might be missing). Searching cache only.');
            }

            // 4. Attempt exact matching
            for (const iscoredName of unmappedNames) {
                const searchName = iscoredName.toLowerCase();
                
                const match = guild.members.cache.find(m => 
                    m.user.username.toLowerCase() === searchName ||
                    m.nickname?.toLowerCase() === searchName ||
                    m.user.globalName?.toLowerCase() === searchName
                );

                if (match) {
                    logInfo(`   Auto-mapped: iScored '${iscoredName}' -> Discord @${match.user.tag}`);
                    await db.run(
                        `INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)`,
                        match.id, iscoredName
                    );
                } else {
                    logWarn(`   ❌ No match found for iScored user: '${iscoredName}'`);
                }
            }

        } catch (error) {
            logError('❌ Error during reconcileMappings:', error);
        }
    }
}
