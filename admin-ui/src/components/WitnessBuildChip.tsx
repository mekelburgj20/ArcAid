/**
 * W60 - which Arcaid Witness build a paired device last said it was running
 * ("Witness 1.0.8"). The cabinet reports it as `v=` on its check-in and
 * heartbeat; a device that never sent one (a cabinet before 1.0.8) reads as
 * "Witness build unknown (before 1.0.8)" in the same muted style: the cabinet
 * never said, which is not an error. Display only - nothing keys on it.
 *
 * Wraps rather than truncates: a game or build name is never ellipsized.
 */
export default function WitnessBuildChip({ version, className = '' }: { version?: string | null; className?: string }) {
  const known = typeof version === 'string' && version.trim() !== '';
  return (
    <span
      data-testid="witness-build-chip"
      className={`inline-block px-1.5 py-px rounded text-[10px] border border-border text-faint break-words ${className}`}
    >
      {known ? `Witness ${version}` : 'Witness build unknown (before 1.0.8)'}
    </span>
  );
}
