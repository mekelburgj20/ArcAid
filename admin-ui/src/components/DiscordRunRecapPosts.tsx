/**
 * Room Settings -> Discord -> **Post run recaps to Discord** (B31.5).
 *
 * Edits the one key the server's `RunRecapPostService` reads (through
 * `src/utils/discordRunRecaps.ts`): `DISCORD_RUN_RECAPS_ENABLED` (absent = off).
 * Instant-save via `onSaveNow`, like DiscordScorePosts; `''` removes the row.
 */

export const DISCORD_RUN_RECAPS_ENABLED_KEY = 'DISCORD_RUN_RECAPS_ENABLED';

interface Props {
  settings: Record<string, string>;
  /** The page's instant-save (optimistic, reverts on failure). */
  onSaveNow: (patch: Record<string, string>) => void | Promise<void>;
}

export default function DiscordRunRecapPosts({ settings, onSaveNow }: Props) {
  const enabled = settings[DISCORD_RUN_RECAPS_ENABLED_KEY] === 'true';

  const toggle = () => {
    onSaveNow({ [DISCORD_RUN_RECAPS_ENABLED_KEY]: enabled ? '' : 'true' });
  };

  return (
    <div className="pt-3 mt-3 border-t border-border/30" data-testid="discord-run-recaps">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-primary">Post run recaps to Discord</p>
          <p className="text-xs text-muted">
            When a run ends, the bot posts its Arcaid Recap to the Run recaps channel (or the
            Tournament posts channel).
          </p>
          <p className="text-xs text-faint" data-testid="run-recaps-where">
            Where they go: the Run recaps row under Announcement channels (same as Tournament posts
            unless set); a tournament can override it in its own Announcements setting.
          </p>
        </div>
        <button
          type="button"
          onClick={toggle}
          role="switch"
          aria-checked={enabled}
          aria-label="Post run recaps to Discord"
          data-testid="run-recaps-toggle"
          className="relative shrink-0 w-12 h-6 min-h-[44px] flex items-center rounded-full transition-colors cursor-pointer border-none bg-transparent"
        >
          <span
            className={`relative block w-12 h-6 rounded-full transition-colors ${
              enabled ? 'bg-neon-cyan' : 'bg-raised border border-border'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${
                enabled ? 'translate-x-6' : ''
              }`}
            />
          </span>
        </button>
      </div>
    </div>
  );
}
