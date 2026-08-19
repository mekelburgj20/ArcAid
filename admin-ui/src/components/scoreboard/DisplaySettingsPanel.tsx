import { useState, type ReactNode } from 'react';
import { Smartphone } from 'lucide-react';
import { api } from '../../lib/api';
import NeonButton from '../NeonButton';
import ImageCropper from '../ImageCropper';
import TitleStyleSelect from '../TitleStyleSelect';
import StyleProfiles from '../StyleProfiles';
import StyleThemePicker from './StyleThemePicker';
import { normalizeQrPosition, deriveQrOffsetPx, DEFAULT_QR_OFFSET_PX } from '../../lib/scoreboardConfig';
import { SCOREBOARD_TOGGLES, TITLE_STYLE_OPTIONS, TITLE_SIZE_OPTIONS } from '../../lib/displaySettings';
import { resizeImageToMaxBox } from '../../lib/imageResize';
import { getTitleStyleClass, getTitleSizeClass } from '../ScoreboardComponents';

/**
 * v2.116.0 (C1) — the room's scoreboard appearance controls, lifted verbatim
 * out of the Settings page's "Leaderboard Display" card so they can be hosted
 * beside the REAL scoreboard on the admin Leaderboard page.
 *
 * This is a relocation, not a redesign: the structure (Style Profiles →
 * Looks/Theme picker → the five toggles → Fine tuning → Branding), every
 * control, every default and every label are the ones that shipped on
 * Settings. What changed is where the edits go — the host owns a DRAFT copy of
 * the room's scoreboard-config and renders the real surface from it, so every
 * control on this panel live-previews against actual cards and actual scores
 * instead of the mock-data preview it used to sit next to.
 *
 * Two write paths, deliberately distinct:
 *   - `onChange`       — a DRAFT edit. Nothing reaches the server until Save.
 *   - `onServerChange` — a key the server has ALREADY persisted. The image
 *     upload/delete endpoints write `SCOREBOARD_BG_URL` / `LOGO_URL`
 *     themselves, so reporting those as unsaved changes would be a lie (and
 *     Save would re-post a value that is already stored).
 */

/**
 * Two heading tiers inside the panel, and they must not look alike.
 *
 * Owner report, 2026-08-15: "Branding is the same heading style as Background
 * Image — even though Background Image is subordinate to Branding." It was:
 * the group heading and its own children were rendering the identical cyan
 * left-bar treatment, so the hierarchy read flat.
 *
 * GROUP  — a top-level division (Fine tuning, Branding). Larger, wider
 *          tracking, full-width rule beneath it.
 * SUB    — a block inside a group (Background Image, Logo). The cyan left-bar,
 *          one visible level down.
 */
const GROUP_HEADING_CLASS =
  'text-[13px] font-display uppercase tracking-[0.18em] text-primary mb-3 pb-1.5 border-b border-border/40';
const SUB_HEADING_CLASS =
  'text-xs font-display uppercase tracking-wider text-neon-cyan/70 mb-2 pl-2 border-l-2 border-neon-cyan/30';

const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";

export interface DisplaySettingsPanelProps {
  roomId: string;
  roomName?: string;
  /** The host's DRAFT scoreboard-config map. */
  settings: Record<string, string>;
  /** Draft edit — not written until the host saves. */
  onChange: (key: string, value: string) => void;
  /** A key the server persisted on its own (image upload/delete). */
  onServerChange: (key: string, value: string) => void;
  /** Drives the Style Profiles warning about snapshotting SAVED settings. */
  hasUnsavedChanges: boolean;
  /**
   * Build trap #4 — "Apply" on a style profile writes server-side
   * immediately, so an unsaved draft would silently overwrite the applied
   * profile on the next Save. Return false to abort the apply.
   */
  onBeforeProfileApply?: () => boolean;
  /** Fired after a profile applied: the host re-pulls its config. */
  onProfileApplied: () => void;
  toast: (msg: string, kind?: 'success' | 'error') => void;
  /**
   * Desktop-only affordance: the room's phone rendering genuinely differs
   * (QR is inert ≤640px, SCOREBOARD_MOBILE_*), and an admin at a desktop
   * cannot see it from the surface behind this panel. Omitted on a phone —
   * you are already looking at the mobile render.
   */
  renderPhonePreview?: () => ReactNode;
}

export default function DisplaySettingsPanel({
  roomId, roomName, settings, onChange, onServerChange,
  hasUnsavedChanges, onBeforeProfileApply, onProfileApplied, toast,
  renderPhonePreview,
}: DisplaySettingsPanelProps) {
  const [uploadingBg, setUploadingBg] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [cropTarget, setCropTarget] = useState<'bg' | 'logo' | null>(null);
  const [phonePreviewOpen, setPhonePreviewOpen] = useState(false);

  const bgUrl = settings.SCOREBOARD_BG_URL || '';
  const logoUrl = settings.LOGO_URL || '';

  const uploadBrandingImage = async (target: 'bg' | 'logo', blob: Blob) => {
    const endpoint = target === 'bg' ? 'background' : 'logo';
    const setUploading = target === 'bg' ? setUploadingBg : setUploadingLogo;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', new File([blob], `${endpoint}.png`, { type: 'image/png' }));
      const result = await api.upload<{ success: boolean; url: string }>(`/rooms/${roomId}/admin/upload/${endpoint}`, formData);
      onServerChange(target === 'bg' ? 'SCOREBOARD_BG_URL' : 'LOGO_URL', result.url);
      toast(`${target === 'bg' ? 'Background' : 'Logo'} uploaded`, 'success');
    } catch (err: any) {
      toast(err.message || 'Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleCropConfirm = async (blob: Blob) => {
    const target = cropTarget;
    setCropSrc(null);
    setCropTarget(null);
    if (!target) return;
    await uploadBrandingImage(target, blob);
  };

  const handleCropCancel = () => {
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
    setCropTarget(null);
  };

  return (
    <div data-testid="display-settings-panel">
      {/* Phone preview — desktop only (see the prop's doc comment). */}
      {renderPhonePreview && (
        <div className="pb-3 mb-3 border-b border-border/40">
          <button
            type="button"
            onClick={() => setPhonePreviewOpen(o => !o)}
            aria-pressed={phonePreviewOpen}
            className={`flex items-center gap-2 min-h-11 px-2 rounded text-xs font-display uppercase tracking-wider cursor-pointer border-none bg-transparent transition-colors ${
              phonePreviewOpen ? 'text-neon-cyan' : 'text-muted hover:text-primary'
            }`}
          >
            <Smartphone size={14} />
            Phone preview
          </button>
          {phonePreviewOpen && (
            <div className="mt-2 border-2 border-dashed border-border/50 rounded-lg p-2 overflow-hidden">
              {renderPhonePreview()}
            </div>
          )}
        </div>
      )}

      {/* P2 — save/apply a whole look across rooms. Sits first: it is the
          two-click path for "make this room look like my other one", and
          everything below it is the manual way to get there. */}
      <StyleProfiles
        roomId={roomId}
        hasUnsavedChanges={hasUnsavedChanges}
        toast={toast}
        onBeforeApply={onBeforeProfileApply}
        onApplied={onProfileApplied}
      />

      {/* New Style/Theme picker — always shown */}
      <StyleThemePicker settings={settings} onChange={onChange} />

      {/* Inline toggles */}
      <div className="pt-3 mt-3 border-t border-border/30 space-y-4">
        {Object.entries(SCOREBOARD_TOGGLES).map(([key, { label, description, defaultOn }]) => {
          const isOn = settings[key] !== undefined ? settings[key] === 'true' : !!defaultOn;
          return (
            <div key={key} className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-primary">{label}</p>
                <p className="text-xs text-muted">{description}</p>
              </div>
              <button
                onClick={() => onChange(key, isOn ? 'false' : 'true')}
                className={`relative w-12 h-6 shrink-0 rounded-full transition-colors cursor-pointer border-none ${
                  isOn ? 'bg-neon-cyan' : 'bg-raised border border-border'
                }`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${isOn ? 'translate-x-6' : ''}`} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Advanced numeric settings */}
      <div className="pt-3 mt-3 border-t border-border/30 space-y-3">
        {/* Was "Advanced" — the SECOND section with that name (the original P0
            audit flagged "two sections both named Advanced"; the collapsible
            one above is now "Display options"). Two identical headings in one
            card is not a hierarchy, it is a coin flip. */}
        <p className={GROUP_HEADING_CLASS}>Fine tuning</p>
        {[
          // Style-system revamp P0 (item 5): SCOREBOARD_MAX_SCORES duplicate
          // removed — the modern-path control lives in StyleThemePicker's
          // "Scores per card" select above. Owner report: this fought "Scores
          // per card". It now TRACKS it when unset (see
          // deriveScoreboardConfig), so the input must show
          // blank-with-a-placeholder rather than advertise a fixed 20 the
          // renderer no longer uses.
          { key: 'SCOREBOARD_MIN_SCORES', label: 'Min Card Height (score rows)', defaultVal: '', placeholder: 'Matches Scores per card', description: 'Leave empty to match Scores per card. Set a number to force taller cards.' },
          { key: 'SCOREBOARD_CARD_SPACING', label: 'Card Spacing (px)', defaultVal: '24', description: 'Gap between game cards in pixels' },
          { key: 'SCOREBOARD_TITLE_FONT_SIZE', label: 'Title Font Size (px)', defaultVal: '0', description: '0 = style default. Override game title font size.' },
          // Style-system revamp P0 (item 7): default aligned to 30 to match
          // the renderer's actual fallback (scoreboardConfig.ts) — this input
          // previously showed 24, drifted from reality.
          { key: 'SCOREBOARD_QR_SIZE', label: 'QR Code Size (px)', defaultVal: '30', description: 'Size of QR codes on game cards. Default: 30.' },
        ].map(({ key, label, defaultVal, description, placeholder }) => (
          <div key={key} className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-primary">{label}</p>
              <p className="text-xs text-muted">{description}</p>
            </div>
            <input
              type="number"
              value={settings[key] ?? defaultVal}
              placeholder={placeholder}
              onChange={e => onChange(key, e.target.value)}
              className={`text-sm text-center rounded border border-border bg-raised px-2 py-1 text-primary ${placeholder ? 'w-44 placeholder:text-[11px]' : 'w-20'}`}
            />
          </div>
        ))}

        {/* QR Position dropdown */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-primary">QR Code Position</p>
            <p className="text-xs text-muted">Where QR codes appear on game cards</p>
          </div>
          <select
            value={normalizeQrPosition(settings.SCOREBOARD_QR_POSITION)}
            onChange={e => onChange('SCOREBOARD_QR_POSITION', e.target.value)}
            className="text-sm rounded border border-border bg-raised px-2 py-1 text-primary"
          >
            <option value="top-center">Top</option>
            <option value="bottom-center">Bottom</option>
          </select>
        </div>

        {/* QR Code Offset — owner spec, 2026-08-15. Signed distance from the
            chosen edge; the default is negative because the QR is meant to
            straddle the border rather than float off it. */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-primary">QR Code Offset (px)</p>
            <p className="text-xs text-muted">
              Distance from the card edge. Negative overlaps the border, positive moves it away. Default: {DEFAULT_QR_OFFSET_PX}.
            </p>
          </div>
          <input
            type="number"
            value={settings.SCOREBOARD_QR_OFFSET_PX ?? String(deriveQrOffsetPx(settings))}
            onChange={e => onChange('SCOREBOARD_QR_OFFSET_PX', e.target.value)}
            className="w-20 text-sm text-center rounded border border-border bg-raised px-2 py-1 text-primary"
          />
        </div>

        {/* Game Title Style dropdown */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-primary">Game Title Style</p>
            <p className="text-xs text-muted">Visual style for game name text on score cards</p>
          </div>
          {/* Style-system revamp P1 (owner ask): each option renders in its own
              title style — impossible with a native <select>, whose <option>s
              ignore text-shadow/gradient/font rules. */}
          <TitleStyleSelect
            className="w-44 shrink-0"
            value={settings.SCOREBOARD_GAME_TITLE_STYLE || 'default'}
            onChange={v => onChange('SCOREBOARD_GAME_TITLE_STYLE', v)}
            options={TITLE_STYLE_OPTIONS}
          />
        </div>

        {/* Mobile Vertical Scroll toggle */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-primary">Mobile Vertical Scroll</p>
            <p className="text-xs text-muted">When on, cards stack vertically on mobile. When off, mobile uses the same layout as desktop.</p>
          </div>
          <button
            onClick={() => onChange('SCOREBOARD_MOBILE_VERTICAL', settings.SCOREBOARD_MOBILE_VERTICAL === 'false' ? 'true' : 'false')}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer ${settings.SCOREBOARD_MOBILE_VERTICAL === 'false' ? 'bg-raised' : 'bg-neon-cyan'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.SCOREBOARD_MOBILE_VERTICAL === 'false' ? 'translate-x-1' : 'translate-x-6'}`} />
          </button>
        </div>

        {/* Mobile Density (S21: shrink is now opt-in; 1.0 = full size default) */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <label className="text-sm font-medium text-primary">Mobile Density</label>
            <p className="text-xs text-muted">Shrink cards to fit more on screen (0.3–1.0). Default 1.0 = full size, matching desktop.</p>
          </div>
          <input
            type="number"
            min="0.3"
            max="1"
            step="0.05"
            value={settings.SCOREBOARD_MOBILE_SCALE || '1.0'}
            onChange={e => onChange('SCOREBOARD_MOBILE_SCALE', e.target.value)}
            className="w-20 rounded bg-deep border border-border px-2 py-1 text-sm text-primary"
          />
        </div>
      </div>

      {/* ── Branding ──────────────────────────────────────────
          Owner call, 2026-08-15: this was its own card BELOW the Leaderboard
          Display card, which read as a separate feature even though the
          background, logo and title it sets are part of the same scoreboard
          the preview beside it is already showing. */}
      <div className="pt-4 mt-4 border-t border-border/30">
        <p className={GROUP_HEADING_CLASS}>Branding</p>
        <div className="space-y-6">
          {/* Background Image */}
          <div>
            <p className={SUB_HEADING_CLASS}>Background Image</p>
            {bgUrl && (
              <div className="mb-3">
                <img src={bgUrl} alt="Background preview" className="max-h-32 rounded border border-border object-cover" />
              </div>
            )}
            <div className="flex items-center gap-3">
              <input
                id="display-bg-upload"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={uploadingBg}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  e.target.value = '';
                  // Backgrounds skip the cropper — the live render uses CSS
                  // background-size: cover, which adapts any aspect to any
                  // viewport. We just resize to a sane bounding box
                  // (1920×1920) preserving aspect.
                  try {
                    const blob = await resizeImageToMaxBox(file, 1920, 1920);
                    await uploadBrandingImage('bg', blob);
                  } catch (err: any) {
                    toast(err?.message || 'Image processing failed', 'error');
                  }
                }}
                className="hidden"
              />
              <NeonButton
                variant="secondary"
                className="text-xs"
                disabled={uploadingBg}
                onClick={() => document.getElementById('display-bg-upload')?.click()}
              >
                {uploadingBg ? 'Uploading...' : bgUrl ? 'Replace Image' : 'Upload Image'}
              </NeonButton>
              {bgUrl && (
                <NeonButton
                  variant="ghost"
                  className="text-xs text-neon-magenta"
                  disabled={uploadingBg}
                  onClick={async () => {
                    setUploadingBg(true);
                    try {
                      await api.delete(`/rooms/${roomId}/admin/upload/background`);
                      onServerChange('SCOREBOARD_BG_URL', '');
                      toast('Background removed', 'success');
                    } catch {
                      toast('Failed to remove background', 'error');
                    } finally {
                      setUploadingBg(false);
                    }
                  }}
                >
                  Remove
                </NeonButton>
              )}
            </div>
            <p className="text-xs text-faint mt-2">PNG, JPEG, or WebP. Max 5 MB. Displayed behind the leaderboard.</p>
            <div className="mt-3">
              <label className="text-xs text-faint block mb-1">Background Mode</label>
              <select
                value={settings.SCOREBOARD_BG_MODE || 'cover'}
                onChange={e => onChange('SCOREBOARD_BG_MODE', e.target.value)}
                className={inputClass}
              >
                <option value="cover">Cover (fill screen)</option>
                <option value="contain">Contain (fit)</option>
                <option value="repeat">Repeat (tile)</option>
                <option value="center">Center</option>
                <option value="fill-entire">Fill Entire (behind title)</option>
              </select>
            </div>
            <div className="mt-3">
              <label className="text-xs text-faint block mb-1">Background Opacity</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={Math.round((parseFloat(settings.SCOREBOARD_BG_OPACITY || '1') * 100))}
                  onChange={e => onChange('SCOREBOARD_BG_OPACITY', String(parseInt(e.target.value, 10) / 100))}
                  className="flex-1 accent-neon-cyan cursor-pointer"
                />
                <span className="text-sm text-muted w-12 text-right">{Math.round((parseFloat(settings.SCOREBOARD_BG_OPACITY || '1') * 100))}%</span>
              </div>
            </div>
          </div>

          {/* Logo Image */}
          <div>
            <p className={SUB_HEADING_CLASS}>Logo</p>
            {logoUrl && (
              <div className="flex items-center justify-between gap-4 mb-3">
                <div>
                  <p className="text-sm text-primary">Show on Leaderboard</p>
                  <p className="text-xs text-faint">Toggle off to hide the logo on the leaderboard while keeping it for Mystery Award.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.SCOREBOARD_LOGO_ENABLED !== 'false'}
                  onClick={() => onChange('SCOREBOARD_LOGO_ENABLED', settings.SCOREBOARD_LOGO_ENABLED === 'false' ? 'true' : 'false')}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer ${settings.SCOREBOARD_LOGO_ENABLED === 'false' ? 'bg-border' : 'bg-neon-cyan/60'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.SCOREBOARD_LOGO_ENABLED === 'false' ? 'translate-x-1' : 'translate-x-6'}`} />
                </button>
              </div>
            )}
            {logoUrl && (
              <div className="mb-3">
                <img src={logoUrl} alt="Logo preview" className="max-h-16 rounded border border-border object-contain" />
              </div>
            )}
            <div className="flex items-center gap-3">
              <input
                id="display-logo-upload"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={uploadingLogo}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  e.target.value = '';
                  const url = URL.createObjectURL(file);
                  setCropSrc(url);
                  setCropTarget('logo');
                }}
                className="hidden"
              />
              <NeonButton
                variant="secondary"
                className="text-xs"
                disabled={uploadingLogo}
                onClick={() => document.getElementById('display-logo-upload')?.click()}
              >
                {uploadingLogo ? 'Uploading...' : logoUrl ? 'Replace Logo' : 'Upload Logo'}
              </NeonButton>
              {logoUrl && (
                <NeonButton
                  variant="ghost"
                  className="text-xs text-neon-magenta"
                  disabled={uploadingLogo}
                  onClick={async () => {
                    setUploadingLogo(true);
                    try {
                      await api.delete(`/rooms/${roomId}/admin/upload/logo`);
                      onServerChange('LOGO_URL', '');
                      toast('Logo removed', 'success');
                    } catch {
                      toast('Failed to remove logo', 'error');
                    } finally {
                      setUploadingLogo(false);
                    }
                  }}
                >
                  Remove
                </NeonButton>
              )}
            </div>
            <p className="text-xs text-faint mt-2">
              PNG, JPEG, or WebP. Max 5 MB. Shown alongside the leaderboard title.
              A 1:1 (square) crop is also used as this room's badge on the Global Scoreboard.
              Non-square logos will prompt for a square crop on upload.
            </p>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <label className="text-xs text-faint block mb-1">Logo Position</label>
                <select
                  value={settings.LOGO_POSITION || 'left'}
                  onChange={e => onChange('LOGO_POSITION', e.target.value)}
                  className={inputClass}
                >
                  <option value="left">Left of title</option>
                  <option value="right">Right of title</option>
                  <option value="above">Above title</option>
                  <option value="below">Below title</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-faint block mb-1">Logo Max Height (px)</label>
                <input
                  type="number"
                  value={settings.LOGO_MAX_HEIGHT || '64'}
                  onChange={e => onChange('LOGO_MAX_HEIGHT', e.target.value)}
                  className={inputClass}
                  min="16"
                  max="256"
                />
              </div>
            </div>

            {/* Scoreboard Title */}
            <div className="mt-3">
              <label className="text-xs text-faint block mb-1">Leaderboard Title</label>
              <input
                type="text"
                value={settings.SCOREBOARD_TITLE || ''}
                onChange={e => onChange('SCOREBOARD_TITLE', e.target.value)}
                placeholder="Leave empty to use room name"
                className={inputClass}
              />
            </div>

            {/* Live title preview */}
            <div className="mt-3 p-3 bg-surface rounded border border-border/50">
              <div className={`flex items-center justify-center gap-3 py-2 ${
                (settings.LOGO_POSITION || 'left') === 'above' || (settings.LOGO_POSITION || 'left') === 'below' ? 'flex-col' : 'flex-row'
              }`}>
                {logoUrl && ((settings.LOGO_POSITION || 'left') === 'left' || (settings.LOGO_POSITION || 'left') === 'above') && (
                  <img src={logoUrl} alt="" style={{ maxHeight: Number(settings.LOGO_MAX_HEIGHT || 64), objectFit: 'contain' }} />
                )}
                <p className={`font-display text-muted ${getTitleSizeClass(settings.SCOREBOARD_TITLE_SIZE || 'sm')} uppercase tracking-widest ${getTitleStyleClass(settings.SCOREBOARD_TITLE_STYLE || 'default')}`}>
                  {settings.SCOREBOARD_TITLE || roomName || 'Leaderboard Title'}
                </p>
                {logoUrl && ((settings.LOGO_POSITION || 'left') === 'right' || (settings.LOGO_POSITION || 'left') === 'below') && (
                  <img src={logoUrl} alt="" style={{ maxHeight: Number(settings.LOGO_MAX_HEIGHT || 64), objectFit: 'contain' }} />
                )}
              </div>
            </div>

            {/* Title Style picker */}
            <div className="mt-3">
              <label className="text-xs text-faint block mb-1.5">Title Style</label>
              <div className="grid grid-cols-3 gap-2">
                {TITLE_STYLE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => onChange('SCOREBOARD_TITLE_STYLE', opt.value)}
                    className={`p-2 rounded border text-center transition-colors ${
                      (settings.SCOREBOARD_TITLE_STYLE || 'default') === opt.value
                        ? 'border-neon-cyan bg-neon-cyan/10'
                        : 'border-border/50 bg-raised hover:border-border'
                    }`}
                  >
                    <span className={`font-display text-sm uppercase tracking-wider block ${getTitleStyleClass(opt.value)}`}>
                      {opt.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Title Size */}
            <div className="mt-3">
              <label className="text-xs text-faint block mb-1">Title Size</label>
              <select
                value={settings.SCOREBOARD_TITLE_SIZE || 'sm'}
                onChange={e => onChange('SCOREBOARD_TITLE_SIZE', e.target.value)}
                className={inputClass}
              >
                {TITLE_SIZE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Branding image cropper overlay */}
      {cropSrc && cropTarget && (
        <ImageCropper
          imageSrc={cropSrc}
          aspectRatio={cropTarget === 'bg' ? 16 / 9 : 1}
          maxOutputWidth={cropTarget === 'bg' ? 1920 : 600}
          onConfirm={handleCropConfirm}
          onCancel={handleCropCancel}
          notice={cropTarget === 'logo' ? 'square-badge' : undefined}
        />
      )}
    </div>
  );
}
