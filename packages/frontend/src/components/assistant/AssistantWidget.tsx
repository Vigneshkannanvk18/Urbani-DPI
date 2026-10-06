import { useCallback, useEffect, useRef, useState } from 'react';
import { AssistantPanel } from './AssistantPanel';
import copilotIcon from '../../assets/copilot-icon.png';

const PANEL_ID = 'assistant-floating-panel';

/**
 * Floating launcher + panel. Mounted once in the authenticated shell. Open/closed
 * is local UI state; the conversation lives in the shared AssistantChatProvider,
 * so it persists across open/close and navigation during the session.
 *
 * Accessibility: labelled launcher with aria-expanded/aria-controls, Escape to
 * close, focus moves to the input on open and back to the launcher on close.
 */
export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    // Return focus to the launcher so keyboard users keep their place.
    launcherRef.current?.focus();
  }, []);

  // Focus the composer when the panel opens.
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  return (
    <>
      {open && (
        <div className="assistant-panel" id={PANEL_ID} role="dialog" aria-label="Urbani Copilot">
          <AssistantPanel variant="floating" onClose={close} inputRef={inputRef} />
        </div>
      )}
      {/* Launcher is hidden while the panel is open so it never overlaps the
          panel's input/Send; the panel's header X is the close affordance.
          Kept mounted (visually hidden) so focus can return to it on close. */}
      <button
        ref={launcherRef}
        type="button"
        className={`assistant-launcher ${open ? 'is-hidden' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="Open Urbani Copilot"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        title="Urbani Copilot"
        aria-hidden={open}
        tabIndex={open ? -1 : 0}
      >
        <img className="assistant-launcher-img" src={copilotIcon} alt="" />
      </button>
    </>
  );
}
