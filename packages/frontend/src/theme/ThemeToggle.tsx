import type { ThemePreference } from '@urbani/shared';
import { THEME_MODES, useTheme } from './ThemeContext';

const LABEL: Record<ThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' };

const ICON: Record<ThemePreference, JSX.Element> = {
  system: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" />
    </svg>
  ),
  light: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  dark: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  ),
};

/**
 * Header theme switch: a three-option group of toggle buttons (System / Light / Dark). Native buttons, so it is keyboard
 * operable (Tab, Enter / Space); the current option is shown visually (highlight + label) and exposed with
 * aria-pressed; the group is labelled with the current state for screen readers.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { mode, resolved, setMode } = useTheme();
  return (
    <div className={`theme-toggle ${className}`} role="group" aria-label={`Colour theme. Current: ${LABEL[mode]}${mode === 'system' ? ` (${resolved})` : ''}`}>
      {THEME_MODES.map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          aria-label={`${LABEL[m]} theme`}
          title={m === 'system' ? `System (currently ${resolved})` : `${LABEL[m]} theme`}
          className={`theme-toggle-btn ${mode === m ? 'is-active' : ''}`}
          onClick={() => setMode(m)}
        >
          {ICON[m]}
          <span className="theme-toggle-label">{LABEL[m]}</span>
        </button>
      ))}
    </div>
  );
}
