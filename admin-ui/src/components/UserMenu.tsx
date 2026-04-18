import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Users, Settings2, Settings as SettingsIcon, LogOut, ChevronDown } from 'lucide-react';

interface DiscordUser {
  discordId: string;
  username: string;
  avatar: string | null;
}

interface UserMenuProps {
  user: DiscordUser;
  /** When true, show the "Scoreboard display" preference trigger. */
  showScoreboardPrefs?: boolean;
  /** When true, show the "Room admin" link pointing at /:slug/admin. */
  hasAdminToken?: boolean;
  /** Current room slug — required for the admin link, optional otherwise. */
  slug?: string;
  onLogout: () => void;
}

export default function UserMenu({ user, showScoreboardPrefs, hasAdminToken, slug, onLogout }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Sprint 13: WAI-ARIA menu pattern — keyboard navigation across items.
  // ArrowDown/Up cycle, Home/End jump, Escape closes + restores trigger focus,
  // Tab exits the menu (standard pattern). Roving tabindex is applied below.
  const getMenuItems = (): HTMLElement[] => {
    const root = menuRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  };

  const moveFocus = (direction: 'next' | 'prev' | 'first' | 'last') => {
    const items = getMenuItems();
    if (items.length === 0) return;
    const currentIdx = items.indexOf(document.activeElement as HTMLElement);
    let nextIdx: number;
    if (direction === 'first') nextIdx = 0;
    else if (direction === 'last') nextIdx = items.length - 1;
    else if (direction === 'next') nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % items.length;
    else nextIdx = currentIdx <= 0 ? items.length - 1 : currentIdx - 1;
    items[nextIdx]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveFocus('next');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocus('prev');
      } else if (e.key === 'Home') {
        e.preventDefault();
        moveFocus('first');
      } else if (e.key === 'End') {
        e.preventDefault();
        moveFocus('last');
      } else if (e.key === 'Tab') {
        // Tab exits the menu naturally — let default handling run but close the menu
        // so it doesn't remain open with stale focus outside it.
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    // Defer focus so React has mounted the menu
    const raf = requestAnimationFrame(() => getMenuItems()[0]?.focus());
    return () => {
      document.removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf);
    };
  }, [open]);

  const openPrefs = () => {
    setOpen(false);
    window.dispatchEvent(new Event('open-scoreboard-prefs'));
  };

  const handleLogout = () => {
    setOpen(false);
    onLogout();
  };

  const menuItemClass = 'flex items-center gap-2 w-full px-3 py-2 text-left text-xs text-muted hover:text-neon-cyan hover:bg-raised rounded transition-colors no-underline cursor-pointer bg-transparent border-0';

  return (
    <div ref={rootRef} className="relative ml-1 sm:ml-2">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="User menu"
        className="flex items-center gap-1.5 p-1 rounded hover:bg-raised transition-colors cursor-pointer bg-transparent border-0"
      >
        {user.avatar ? (
          <img
            src={user.avatar}
            alt=""
            className="w-6 h-6 rounded-full border border-border"
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-neon-cyan/20 border border-border flex items-center justify-center text-[10px] font-bold text-neon-cyan">
            {user.username.charAt(0).toUpperCase()}
          </div>
        )}
        <span className="hidden lg:inline text-xs text-muted truncate max-w-[80px]">{user.username}</span>
        <ChevronDown size={12} className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="User menu"
          className="absolute right-0 top-full mt-1 w-56 bg-surface border border-border rounded-lg shadow-lg z-30 py-1"
        >
          {/* Identity header */}
          <div className="px-3 py-2 border-b border-border/50">
            <p className="text-xs text-primary font-medium truncate">{user.username}</p>
            <p className="text-[10px] text-faint">Logged in with Discord</p>
          </div>

          {/* Items — tabIndex=-1 per WAI-ARIA menu pattern; navigation is via
              arrow keys (Tab closes the menu, see the keydown effect above). */}
          <div className="py-1">
            <Link
              role="menuitem"
              tabIndex={-1}
              to="/my-rooms"
              onClick={() => setOpen(false)}
              className={menuItemClass}
            >
              <Building2 size={14} />
              My Rooms
            </Link>
            <Link
              role="menuitem"
              tabIndex={-1}
              to="/friends"
              onClick={() => setOpen(false)}
              className={menuItemClass}
            >
              <Users size={14} />
              Friends
            </Link>
            {showScoreboardPrefs && (
              <button
                role="menuitem"
                tabIndex={-1}
                type="button"
                onClick={openPrefs}
                className={menuItemClass}
              >
                <Settings2 size={14} />
                Scoreboard display
              </button>
            )}
            {hasAdminToken && slug && (
              <Link
                role="menuitem"
                tabIndex={-1}
                to={`/${slug}/admin`}
                onClick={() => setOpen(false)}
                className={menuItemClass}
              >
                <SettingsIcon size={14} />
                Room admin
              </Link>
            )}
          </div>

          {/* Logout */}
          <div className="border-t border-border/50 pt-1">
            <button
              role="menuitem"
              tabIndex={-1}
              type="button"
              onClick={handleLogout}
              className={`${menuItemClass} hover:text-neon-magenta`}
            >
              <LogOut size={14} />
              Log out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
