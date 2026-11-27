import Button from '../parts/Button';
import { useToast } from '../Toast';

/**
 * Copies the server-built Discord text (`RunRecap.discord_text`). Same chain as
 * `ShareButton`: the async clipboard, then the legacy textarea copy, then a
 * failure toast. Visible to everyone.
 */
function legacyCopy(value: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export default function CopyForDiscordButton({ text }: { text: string }) {
  const { toast } = useToast();
  const copy = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      // Fall through to the legacy copy.
    }
    if (!ok) ok = legacyCopy(text);
    if (ok) toast('Copied — paste it in Discord', 'success');
    else toast("Couldn't copy. Select the text and copy it by hand.", 'error');
  };
  return (
    <Button variant="secondary" size="sm" onClick={copy} disabled={!text}>
      Copy for Discord
    </Button>
  );
}
