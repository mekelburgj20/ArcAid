import { useState } from 'react';
import { X } from 'lucide-react';

interface PinnedMessageProps {
  content: string;
  roomId: string;
}

export default function PinnedMessage({ content, roomId }: PinnedMessageProps) {
  const storageKey = `lobby_pinned_dismissed_${roomId}`;
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(storageKey) === '1');

  if (dismissed || !content) return null;

  const dismiss = () => {
    sessionStorage.setItem(storageKey, '1');
    setDismissed(true);
  };

  return (
    <div className="bg-neon-cyan/5 border border-neon-cyan/20 rounded-lg px-4 py-2 flex items-start gap-3">
      <span className="text-sm text-primary flex-1">{content}</span>
      <button
        onClick={dismiss}
        className="text-muted hover:text-primary cursor-pointer bg-transparent border-0 p-0.5 flex-shrink-0"
      >
        <X size={14} />
      </button>
    </div>
  );
}
