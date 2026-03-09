import NeonButton from './NeonButton';

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({ title, message, confirmLabel = 'Confirm', onConfirm, onCancel }: ConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm" onClick={onCancel}>
      <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="font-display text-lg font-bold text-primary mb-2">{title}</h3>
        <p className="text-muted mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <NeonButton variant="ghost" onClick={onCancel}>Cancel</NeonButton>
          <NeonButton variant="danger" onClick={onConfirm}>{confirmLabel}</NeonButton>
        </div>
      </div>
    </div>
  );
}
