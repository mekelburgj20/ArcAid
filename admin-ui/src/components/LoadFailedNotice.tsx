import Button from './parts/Button';

interface LoadFailedNoticeProps {
  /** What did not load, as it reads after "Couldn't load": "the scores", "the activity". */
  what: string;
  /** Ask again now. The page is already retrying by itself; no handler, no button. */
  onRetry?: () => void;
  testId?: string;
  /** Layout only (padding, flex growth). The words and the button are fixed. */
  className?: string;
}

/**
 * What a page shows in place of its content while a load has not been answered
 * and the last try failed (`phase === 'retrying'` from `useRetryingLoad`).
 *
 * It is NOT an empty state: the page does not yet know whether there is
 * anything to show, so its "nothing here yet" text must wait for an answer
 * (G31 v2.265.4, G32). The retry is the loader's; "Try now" only skips the wait.
 */
export default function LoadFailedNotice({ what, onRetry, testId = 'load-failed', className = 'py-16' }: LoadFailedNoticeProps) {
  return (
    <div className={`flex flex-col items-center gap-3 text-center ${className}`} role="status" data-testid={testId}>
      <p className="text-primary font-display">Couldn't load {what}</p>
      <p className="text-muted text-sm max-w-xs">Trying again automatically.</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="min-h-11 px-4" onClick={onRetry}>
          Try now
        </Button>
      )}
    </div>
  );
}
