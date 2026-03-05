# ArcAid Project Handover Manifest (v0.1-beta)

## 1. Project Overview
**ArcAid** is the successor to TableFlipper. It is a modern, platform-agnostic tournament management system designed to be server-independent and highly customizable.
*   **Target Version**: `0.1.0-beta`
*   **Baseline Tech**: Node.js, TypeScript, SQLite, Playwright, React (Vite) for Admin UI.
*   **Repository**: `C:\code
epos\ArcAid`

## 2. Core Architectural Pillars
- **Generic Engine**: All internal logic uses generic terms: `Games` and `Tournaments`.
- **Terminology Toggle**: A configuration setting allows for "Pinball Legacy" mode (mapping Games->Tables and Tournaments->Grinds) for backward compatibility with the TableFlipper experience.
- **Admin UI**: A locally-hosted React dashboard for configuration, tournament management, and real-time log viewing.
- **Lightweight Leaderboard**: An internal, high-performance scoreboard engine with a real-time API (REST/WebSockets) to reduce dependency on external services like iScored.
- **Cadence-Based Backups**: Automated snapshots of the tournament state for redundancy.
- **Standalone Restore**: A decoupled script for rebuilding the scoreboard/leaderboard state without the main bot running.

## 3. High-Priority Features to Port (Refactored)
- **iScored Browser Automation**: Port the robust login and table-repositioning logic.
- **120-Day Eligibility**: Rolling lookback to ensure game variety.
- **Runner-Up Fallback**: The 1-hour/30-minute tiered timeout system for winner picks.
- **Identity Mapping**: Discord-to-Leaderboard user mapping logic.

## 4. Setup Strategy (Safe Development)
- **Discord Bot**: Use a new "ArcAid Beta" Discord application/token for testing.
- **Database**: `data/arcaid.db` (Fresh schema).
- **Environment**: `.env` for initial setup, transitioning to DB-backed configuration via the Admin UI.
- **Deployment**: Provide a `Dockerfile` and `docker-compose.yml` for "One-Command" cross-platform installation (Windows, Linux, Mac).

## 5. Next Steps for Gemini CLI
1. Initialize the `ArcAid` repository and folder structure.
2. Scaffold the generic tournament/game database schema.
3. Implement the Terminology Toggle translation layer.
4. Build the "First-Run" Admin UI setup wizard.
