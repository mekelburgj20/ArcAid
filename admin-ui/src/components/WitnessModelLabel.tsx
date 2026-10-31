/**
 * W73 - which AtGames cabinet model a paired device is ("Legends Ultimate \u00b7
 * HA9920"). The cabinet reports the family name and the model code on its
 * pair / check-in / heartbeat; a device that never said reads "model unknown".
 * Display only. Wraps rather than truncates.
 */
export default function WitnessModelLabel({ model, modelName, className = '' }: {
  model?: string | null; modelName?: string | null; className?: string;
}) {
  const parts = [modelName, model].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return (
    <span data-testid="witness-model-label" className={`inline-block text-[10px] text-faint break-words ${className}`}>
      {parts.length > 0 ? parts.join(' \u00b7 ') : 'model unknown'}
    </span>
  );
}
