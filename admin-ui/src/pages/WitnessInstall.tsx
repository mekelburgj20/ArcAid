import { Link } from 'react-router-dom';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { KitDownloadButton } from '../components/WitnessKitDownload';
import { kitSize, useWitnessGuide, useWitnessKit } from '../lib/witnessKit';

/**
 * W102 - the install guide, `/witness/install`. Readable without a login; the
 * download step shows the kit button for a signed-in player and a login prompt
 * for a guest. The copy is the owner's plain-language wording.
 */

const STEPS_BEFORE_PAIR = [
  'Unzip it. Inside is one folder named arcaid-witness.',
  'Turn the cabinet off and move its USB stick to your computer.',
  "Open the stick's external folder. Copy the arcaid-witness folder into it, next to the folders whose names start with vpx-.",
  'Put the stick back and turn the cabinet on.',
  'Open External Applications and start [Arcaid Witness].',
];

function Heading({ children }: { children: string }) {
  return <h2 className="font-display text-base font-bold mt-6 mb-2">{children}</h2>;
}

export default function WitnessInstall() {
  const { playerToken, loginWithDiscord } = useViewerAuth();
  const kit = useWitnessKit(playerToken);
  const { videoUrl } = useWitnessGuide();

  return (
    <div className="min-h-screen bg-deep text-primary p-4">
      <div className="mx-auto w-full max-w-2xl bg-surface border border-border rounded-lg p-6" data-testid="witness-install">
        <h1 className="font-display text-xl font-bold mb-2">Install Arcaid Witness on your cabinet</h1>
        <p className="text-sm text-muted">
          Arcaid Witness is a small app for AtGames Legends pinball cabinets. It watches the Visual Pinball tables you play and posts your scores to Arcaid by itself.
        </p>
        {videoUrl && (
          <p className="mt-2 text-sm">
            <a href={videoUrl} target="_blank" rel="noopener noreferrer" className="underline text-neon-cyan">Watch the install video</a>
          </p>
        )}

        <Heading>What you need</Heading>
        <ul className="list-disc pl-5 space-y-1 text-sm text-muted">
          <li>A cabinet with the External Applications menu and the Legends Unchained Visual Pinball launcher on a USB stick.</li>
          <li>The cabinet on Wi-Fi.</li>
          <li>An Arcaid account.</li>
        </ul>

        <Heading>Steps</Heading>
        <ol className="list-decimal pl-5 space-y-3 text-sm">
          <li>
            <span className="font-medium">Download the kit.</span>
            <div className="mt-2">
              {playerToken ? (
                kit ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <KitDownloadButton playerToken={playerToken} />
                    <span className="text-xs text-muted">Version {kit.version}{kit.sizeBytes > 0 ? ` · ${kitSize(kit.sizeBytes)}` : ''}</span>
                  </div>
                ) : (
                  <p className="text-xs text-muted">The kit is not available right now. Check back soon.</p>
                )
              ) : (
                <button
                  type="button"
                  onClick={() => loginWithDiscord('__global__', '/witness/install')}
                  className="px-4 py-1.5 rounded border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan text-sm font-medium hover:bg-neon-cyan/20 cursor-pointer"
                >
                  Log in to download
                </button>
              )}
            </div>
          </li>
          {STEPS_BEFORE_PAIR.map(s => <li key={s} className="text-muted">{s}</li>)}
          <li className="text-muted">
            Choose Pair this cabinet. Scan the code on the screen with your phone and approve it. Or open{' '}
            <Link to="/pair" className="underline text-neon-cyan">arcaid.app/pair</Link> and type the code.
          </li>
          <li className="text-muted">Play. Your scores post by themselves.</li>
        </ol>

        <Heading>Every time you turn the cabinet on</Heading>
        <p className="text-sm text-muted">
          Open the [Arcaid Witness] tile once. The cabinet does not start it for you. Games you played before opening it are picked up when you do.
        </p>

        <Heading>Updates</Heading>
        <p className="text-sm text-muted">
          From version 1.1.0 the cabinet fetches new versions itself. After an update arrives, open the tile once to start it. If you ever update by hand, copy the new files over the old ones. Never delete the arcaid-witness folder: it holds your pairing.
        </p>

        <Heading>Which tables post scores</Heading>
        <p className="text-sm text-muted">
          Most tables with a ROM post every game. Tables without a ROM post one score when you leave the table, so leave the table after each game. Some tables write no score at all. Games with two or more players are not posted.
        </p>

        <Heading>Need help</Heading>
        <p className="text-sm text-muted">
          In <Link to="/account/settings#witness-devices" className="underline text-neon-cyan">Account Settings</Link>, under Arcaid Witness devices, use Get logs and then Send to Arcaid support.
        </p>
      </div>
    </div>
  );
}
