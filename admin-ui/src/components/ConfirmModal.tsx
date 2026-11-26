import { ConfirmDialog } from './parts/Dialog';

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** `red` (default) for harm (Delete), `pink` for attention (Leave room). */
  tone?: 'pink' | 'red';
}

/**
 * "Are you sure?" for a page that shows it only while asking (it is mounted
 * while open). Since v2.269.0 (G23) it is the Arcaid confirm,
 * `parts/Dialog`'s `ConfirmDialog`: the fixed dark slab in the tone, focus
 * starting on Cancel (the owner's pick; it was the action before), and
 * Escape, a press outside or the corner x cancelling. Its label repeats the
 * action's words, so a test finds the action by its role, not its text.
 */
export default function ConfirmModal({ title, message, confirmLabel = 'Confirm', onConfirm, onCancel, tone = 'red' }: ConfirmModalProps) {
  return (
    <ConfirmDialog
      open
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      onConfirm={onConfirm}
      onCancel={onCancel}
      tone={tone}
    />
  );
}
