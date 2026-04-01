You are an expert in prompt engineering, specializing in optimizing AI code assistant instructions. Your task is to analyze and improve the instructions for Claude Code. Follow these steps carefully:

Analysis Phase: Review the chat history in your context window.
Then, examine the current Claude instructions, commands, config, and memory <claude_instructions> /CLAUDE.md /.claude/commands/* **/CLAUDE.md .claude/settings.local.json ~/.claude/projects/*/memory/MEMORY.md </claude_instructions>

Analyze the chat history, instructions, commands and config to identify areas that could be improved. Look for:

Inconsistencies in Claude's responses
Misunderstandings of user requests
Areas where Claude could provide more detailed or accurate information
Opportunities to enhance Claude's ability to handle specific types of queries or tasks
New commands or improvements to a commands name, function or response
Permissions and MCPs we've approved locally that we should add to the config, especially if we've added new tools or require them for the command to work
Interaction Phase: Present your findings and improvement ideas to the human. For each suggestion: a) Explain the current issue you've identified b) Propose a specific change or addition to the instructions c) Describe how this change would improve Claude's performance
Wait for feedback from the human on each suggestion before proceeding. If the human approves a change, move it to the implementation phase. If not, refine your suggestion or move on to the next idea.

Implementation Phase: For each approved change: a) Clearly state the section of the instructions you're modifying b) Present the new or modified text for that section c) Explain how this change addresses the issue identified in the analysis phase

Output Format: Present your final output in the following structure:

[List the issues identified and potential improvements] [For each approved improvement: 1. Section being modified 2. New or modified instruction text 3. Explanation of how this addresses the identified issue]
<final_instructions> [Present the complete, updated set of instructions for Claude, incorporating all approved changes] </final_instructions>

Relevant Documentation:

**Active (update regularly):**
- `README.md` — Public-facing feature list, URL structure, commands, config, tech stack
- `ROADMAP.md` — Completed work, future plans, sprint history
- `SPRINT_STATUS.md` — Live progress tracker, last session notes, blockers
- `CLAUDE.md` (ArcAid root) — Architecture tables, key patterns, database schema, session checklist
- `../CLAUDE.md` (parent repo root) — Repository overview, architecture tables shared across projects

**Reference (update occasionally):**
- `VIDEO_TUTORIAL_GUIDE.md` — Video tutorial scripts, episode list, B-roll checklist, production standards
- `DISCORD_SETUP.md` — Discord bot setup and configuration guide
- `PolyForm Noncommercial License 1.0.0.md` — Project license terms
- `.claude/commands/deploy.md` — Production deployment checklist slash command
- `.claude/commands/update-docs.md` — Documentation update slash command

**Archival (all items implemented, keep for historical context):**
- `UX_Leaderboard_Plan.md` — UX design plan with priority matrix (all items P0-P3 complete)
- `Leaderboard_RoomSettings_Redesign.md` — Original redesign requirements from user (all implemented)
- `followup.md` — Deferred items with user answers (all implemented)

Remember, your goal is to enhance Claude's performance and consistency while maintaining the core functionality and purpose of the AI assistant. Be thorough in your analysis, clear in your explanations, and precise in your implementations.