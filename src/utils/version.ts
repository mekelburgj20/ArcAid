import fs from 'fs';
import path from 'path';
import { logError } from './logger.js';

export interface VersionInfo {
    version: string;
    commit: string | null;
    builtAt: string | null;
}

let cachedVersion: string | null = null;

/**
 * Resolve the app version. Primary source is `npm_package_version`, which npm
 * sets for the prod `npm start` CMD (Dockerfile) from the root package.json —
 * the single source of truth. Falls back to reading package.json from the
 * process CWD (`/app` in the prod image) if the env var is somehow unset.
 */
function resolveVersion(): string {
    if (cachedVersion) return cachedVersion;

    const fromEnv = process.env.npm_package_version;
    if (fromEnv) {
        cachedVersion = fromEnv;
        return fromEnv;
    }

    try {
        const pkgPath = path.join(process.cwd(), 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        cachedVersion = pkg.version || 'unknown';
    } catch (err) {
        logError('version: failed to read package.json for version fallback:', err);
        cachedVersion = 'unknown';
    }
    return cachedVersion as string;
}

/**
 * App version + build metadata for the S10 in-app version display.
 * `commit` / `builtAt` are baked at image build via Docker build-args
 * (`APP_GIT_SHA` / `APP_BUILT_AT`, wired in deploy.yml + Dockerfile);
 * both are null in local/dev builds. NOT the SW CACHE_NAME.
 */
export function getVersionInfo(): VersionInfo {
    return {
        version: resolveVersion(),
        commit: process.env.APP_GIT_SHA || null,
        builtAt: process.env.APP_BUILT_AT || null,
    };
}
