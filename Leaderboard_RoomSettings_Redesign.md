UX Design
1. How hard would it be to create an Android and iOS App that is basically a wrapper for the ArcAid.app game room (admin portal and public portal)?
2. Theme selection: Scorecard design/style should have its own theme selector. The cards, including the ranking card, should all have a matching style based on scoreboard theme selection. For now, let's use the existing theme styles we have and create a Leaderboard Theme selection. 
    a. The Room Admin theme selection needs to be broken down in to 'Admin Theme' and 'Public Theme'. Admin theme is applied only to all of the exclusive admin pages. Public theme is applied to all public viewable pages. This may be as simple as renaming the 'Global Theme' to 'Public Theme'. 
3. The Room Settings - Settings need to be reorganized so that like settings are grouped next to eachother. Example, The Scoreboard Branding needs to be next to Scoreboard settings. Analyze the rest of the settings as well to determine most logical placement
    a. Rank and prioritize the layout position of settings so that the predicted most commonly used/changed settings are closer to the top. Or perhaps, the most important required settings at the top. 
    b. Do we still need System Actions 'Reload Scheduler'? What scenario would this be useful for? 
    c. Other: Settings - LOGO_POSITION, Scoreboard_BG_MODE, SCOREBOARD_BG_OPACITY, SCOREBOARD_BG_URL, and PLATFORMS all seem to be duplicate settings at this point. Probably forgot to clean up this 'Others' section. Confirm and remove if confirmed. 
    d. Look at the 'Features' settings and move items under other settings headers if/when it makes sense. For example, I think 'Hide Scoreboard Title' and 'Require Photo with Score Submission' belong in the Scoreboard settings header. 
    e. Kiosk settings should be part of Scoreboard and should also include a setting called 'Kiosk Enabled' with a toggle. If disabled, the kiosk page is not available. 
    f. System settings - I don't think most of these belong in Room Admin settings and should only be available to the ArcAid global admin. In fact, I don't think we need any of these. Analysis?
    g. Add Custom Setting: What is this even for?
    h. Tournament Defaults - These should be part of each tournament's config/setup. We don't need to give the room admins defaults, we can just have them set in the backend and note the defaults in the 'Help' menu, as well as just have the Tournament config default to these values. Let's set both the Winnder Pick Windows and Runner-up window to 90 minutes. We don't need the Bot Timezone setting. Let's try and get rid of this Tournament Defaults setting header altogether. 
4. Game Library
    a. Platforms: There should be an 'Add' option on the Platforms: display so that Admins (admins only) can click and manually type in a new platform. This should sync with the 'Room Settings -> PLATFORMS' setting values and one should update the other. It's just a convinience thing to have the platform add capability from the Game Library. To delete a Platform though should only be available in the Room Settings. Be sure that if a Platform is deleted, there isn't a logic issue if say a Tournament was bound to a specific platform that has now been removed. Perhaps during the deletion (either clicking the 'x' on the platform name or when saving after deleting one), a validation occurs that checks to see if a platform is in use. And if so, an error is displayed that says something like "The platform {platform name} is currently in use by Tournament(s) {tournament Name} and cannot be deleted. Modify the Tournament settings first and try again".

5. Leaderboard Enhancements (from original design spec)
    NOTE: Many items from the original leaderboard design have already been implemented (ranking card positioning, independent card scrolling, zoom/scaling, background image, logo image, leaderboard name customization, scores per card, hide empty games, score submission from leaderboard, and kiosk mode). The following items remain unimplemented:

    a. Global Game CSS Override UI: The database schema already has per-game CSS fields (`css_title`, `css_initials`, `css_scores`, `css_box`, `bg_color`), but there is no admin UI for setting global overrides. Add a "Global Game Styles" section in settings where admins can define CSS values for TITLE, INITIALS, SCORES, BOX, and BG COLOR that apply uniformly to all game cards, overriding individual game settings when enabled.

    b. QR Codes on Score Cards: Generate a QR code for each game that links directly to a score entry screen for that game. Features:
        i. Option to enable/disable QR codes globally.
        ii. Position options per score card: top-left, top-center, top-right, bottom-left, bottom-center, bottom-right.
        iii. QR code should link to a mobile-friendly score submission page where users can add photo, username, and score from their device (already implemented for on-click/on-touch for Game Title. This just needs to link them directly to that.)
        iv. Submitted scores need to sync with the app database and update iScored with the same submission. (already a functionality?)
    
    c. The Leaderboard scores (public) allow users to log in now. If a user is logged in, the scorecards should show the logged in user's position (rank) on each score card, taking over the last spot (10th) if the user's score is lower than 10th. The user's score should be highlighted to be easy to spot. So if user is in 12th place, the score card for that game will show ranks 1 through 9 and then 12 (in the 10th spot, showing user's score). 

6. - Game Room Admin site should have a log page that shows game room specific events that the admin could review. Things like Bot messages/interactions, game room events like tournament maintenance, user score submissions, user slash command usage, etc. Logs do not need to persist for more than 7 days. 
