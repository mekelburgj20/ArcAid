import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import NeonButton from '../components/NeonButton';
import AwPageShell from '../components/AwPageShell';
import { cleanCode } from '../lib/pairCode';

/**
 * W103 - `/pair`: type the six-character code the cabinet shows, then confirm on `/pair/:code`.
 * W105 (v2.251.0) - in the Arcaid Witness theme; the form is unchanged.
 */
export default function WitnessPairEntry() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  return (
    <AwPageShell sub="PAIR A CABINET" footer={<Link to="/witness/install">INSTALL GUIDE</Link>}>
      <form
        className="aw-panel"
        data-testid="pair-entry"
        onSubmit={e => { e.preventDefault(); if (code) navigate(`/pair/${encodeURIComponent(code)}`); }}
      >
        <h1 className="aw-label">Pair a cabinet</h1>
        <p className="aw-body mb-4">Type the six-character code shown on the cabinet screen.</p>
        <input
          aria-label="Pairing code"
          value={code}
          onChange={e => setCode(cleanCode(e.target.value).slice(0, 6))}
          maxLength={6}
          autoCapitalize="characters"
          autoComplete="off"
          className="w-full mb-4 px-3 py-2 rounded border border-border bg-deep text-primary text-2xl tracking-[0.3em] text-center uppercase"
        />
        <NeonButton type="submit" disabled={code.length === 0} className="w-full">Continue</NeonButton>
      </form>
    </AwPageShell>
  );
}
