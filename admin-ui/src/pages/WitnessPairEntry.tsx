import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import NeonButton from '../components/NeonButton';
import { cleanCode } from '../lib/pairCode';

/** W102 - `/pair`: type the six-character code the cabinet shows, then confirm on `/pair/:code`. */
export default function WitnessPairEntry() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  return (
    <div className="min-h-screen bg-deep text-primary flex items-center justify-center p-4">
      <form
        className="w-full max-w-md bg-surface border border-border rounded-lg p-6"
        data-testid="pair-entry"
        onSubmit={e => { e.preventDefault(); if (code) navigate(`/pair/${encodeURIComponent(code)}`); }}
      >
        <h1 className="font-display text-xl font-bold mb-2">Pair a cabinet</h1>
        <p className="text-sm text-muted mb-4">Type the six-character code shown on the cabinet screen.</p>
        <input
          aria-label="Pairing code"
          value={code}
          onChange={e => setCode(cleanCode(e.target.value).slice(0, 6))}
          maxLength={6}
          autoCapitalize="characters"
          autoComplete="off"
          className="w-full mb-4 px-3 py-2 rounded border border-border bg-deep font-mono text-2xl tracking-[0.3em] text-center uppercase"
        />
        <NeonButton type="submit" disabled={code.length === 0} className="w-full">Continue</NeonButton>
      </form>
    </div>
  );
}
