import { logInfo, logError, logDebug } from '../utils/logger.js';

export interface IScoredApiScore {
    name: string;
    date: string;
    rank: string;
    score: string;
}

export interface IScoredApiGameScores {
    gameName: string;
    GameID: string;
    scores: IScoredApiScore[];
}

export interface IScoredApiSubmitResult extends IScoredApiGameScores {
    submittedScore: {
        name: string;
        rank: string;
        score: string;
    };
}

/**
 * Lightweight HTTP client for the iScored REST API.
 * Replaces Playwright scraping for score reads and writes.
 *
 * API docs: https://www.iscored.info/api/iScoredAPI.docx
 * Requires "Enable API" in iScored gameroom settings.
 */
export class IScoredApiClient {
    private baseUrl = 'https://www.iscored.info/api';
    private gameroomName: string;

    constructor(gameroomName?: string) {
        if (gameroomName) {
            this.gameroomName = gameroomName;
        } else {
            const publicUrl = process.env.ISCORED_PUBLIC_URL || '';
            const match = publicUrl.match(/iscored\.info\/(\w+)/i);
            if (!match) throw new Error('Cannot determine iScored gameroom name from ISCORED_PUBLIC_URL');
            this.gameroomName = match[1] as string;
        }
    }

    /** Check whether the iScored API is reachable and enabled for this gameroom. */
    async isAvailable(): Promise<boolean> {
        try {
            const url = `${this.baseUrl}/${encodeURIComponent(this.gameroomName)}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            return res.ok;
        } catch {
            return false;
        }
    }

    /** Get all games and gameroom settings. */
    async getGameroom(): Promise<any> {
        const url = `${this.baseUrl}/${encodeURIComponent(this.gameroomName)}`;
        logDebug(`iScored API: GET ${url}`);
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`iScored API error: ${res.status} ${res.statusText}`);
        return res.json();
    }

    /** Get top scores for a specific game. Use max=0 for all scores. */
    async getGameScores(gameNameOrId: string, max?: number): Promise<IScoredApiGameScores> {
        let url = `${this.baseUrl}/${encodeURIComponent(this.gameroomName)}/${encodeURIComponent(gameNameOrId)}`;
        if (max !== undefined) url += `?max=${max}`;
        logDebug(`iScored API: GET ${url}`);
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`iScored API error: ${res.status} ${res.statusText}`);
        return res.json();
    }

    /** Get all scores for all games in one call. */
    async getAllScores(): Promise<IScoredApiGameScores[]> {
        const url = `${this.baseUrl}/${encodeURIComponent(this.gameroomName)}/getAllScores`;
        logDebug(`iScored API: GET ${url}`);
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`iScored API error: ${res.status} ${res.statusText}`);
        const data = await res.json();
        // Normalize: API may return a single object or an array
        return Array.isArray(data) ? data : [data];
    }

    /**
     * Submit a score to iScored.
     * Note: The API does not support photo uploads.
     * iScored rejects scores lower than existing best for the same player.
     */
    async submitScore(gameNameOrId: string, playerName: string, score: number): Promise<IScoredApiSubmitResult> {
        const url = `${this.baseUrl}/${encodeURIComponent(this.gameroomName)}/${encodeURIComponent(gameNameOrId)}/submitScore`;
        logDebug(`iScored API: POST ${url} (${playerName}: ${score})`);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `playerName=${encodeURIComponent(playerName)}&score=${score}`,
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`iScored API submitScore error: ${res.status} — ${text}`);
        }
        return res.json();
    }

    /**
     * Create an event on iScored.
     */
    async createEvent(eventName: string): Promise<{ eventId: string; eventName: string; eventStatus: string }> {
        const url = `${this.baseUrl}/${encodeURIComponent(this.gameroomName)}/createEvent`;
        logDebug(`iScored API: POST ${url} (${eventName})`);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `eventName=${encodeURIComponent(eventName)}`,
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`iScored API createEvent error: ${res.status} — ${text}`);
        }
        return res.json();
    }

    /** Start an event. */
    async startEvent(eventId: string): Promise<any> {
        const url = `${this.baseUrl}/${encodeURIComponent(this.gameroomName)}/startEvent`;
        logDebug(`iScored API: POST ${url} (${eventId})`);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `eventId=${encodeURIComponent(eventId)}`,
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`iScored API startEvent error: ${res.status}`);
        return res.json();
    }

    /** Stop an event. */
    async stopEvent(eventId: string): Promise<any> {
        const url = `${this.baseUrl}/${encodeURIComponent(this.gameroomName)}/stopEvent`;
        logDebug(`iScored API: POST ${url} (${eventId})`);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `eventId=${encodeURIComponent(eventId)}`,
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`iScored API stopEvent error: ${res.status}`);
        return res.json();
    }
}
