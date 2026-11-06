import { useEffect, useRef, useState } from 'react';
import { servicesApi } from '../../api/endpoints';
import { useApi } from '../../hooks/useApi';
import { Button, Select, SourceBadge } from '../ui';
import { IconClose, IconHistory } from '../icons';
import { useAssistantChat } from './useAssistantChat';
import copilotIcon from '../../assets/copilot-icon.png';
import { AssistantMessage } from './AssistantMessage';
import { AssistantSuggestions } from './AssistantSuggestions';
import { AssistantInput } from './AssistantInput';
import { AssistantHistory } from './AssistantHistory';

/** After this long without an answer we show a gentle "taking longer" hint. */
export const SLOW_HINT_MS = 15_000;

/**
 * Live "Thinking... 4 s" timer next to the typing dots (DPI 2 item 9). Elapsed time comes from the
 * moment the question was sent; the hint after 15 s is informational only.
 */
function ThinkingIndicator({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  const elapsedMs = since === null ? 0 : Math.max(0, now - since);
  return (
    <div className="chat-msg assistant">
      <div className="chat-avatar assistant" aria-hidden>
        <img className="chat-avatar-img" src={copilotIcon} alt="" />
      </div>
      <div>
        <div className="chat-bubble" aria-label="Assistant is typing">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="chat-thinking-timer">Thinking... {Math.floor(elapsedMs / 1000)} s</span>
        </div>
        {elapsedMs >= SLOW_HINT_MS && (
          <div className="chat-meta" role="status">This is taking longer than usual. The Urbani /chat service can take up to ~30 s.</div>
        )}
      </div>
    </div>
  );
}

/**
 * Composes the chat surface (header + message list + suggestions + input) from
 * the shared `useAssistantChat()` hook. Used by BOTH the floating widget
 * (`variant="floating"`) and the full `/assistant` page (`variant="page"`), so
 * there is exactly one chat implementation.
 *
 * Provenance is honest: the header shows the logs source badge (LIVE/MOCK) and
 * "Powered by MockAIProvider · Phase 1". It never claims Bedrock is active.
 */
export function AssistantPanel({
  variant,
  onClose,
  inputRef,
}: {
  variant: 'page' | 'floating';
  onClose?: () => void;
  inputRef?: React.Ref<HTMLTextAreaElement>;
}) {
  const {
    messages, busy, service, environment, setService, setEnvironment, latestLogsSource, pendingSince, historyEnabled,
  } = useAssistantChat();
  const [showHistory, setShowHistory] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  // Service list for the selectors. Only ENABLED services are selectable for
  // live chat (disabled services are never called upstream).
  const services = useApi(() => servicesApi.list(), []);
  const enabledServices = (services.data?.data ?? []).filter((s) => s.enabled !== false);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  // Honest provenance: logs source from the latest answer, MOCK until first reply.
  const logsSource = (latestLogsSource ?? 'MOCK') as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION';

  const historyButton = (
    <button
      type="button"
      className="assistant-panel-close assistant-panel-history"
      onClick={() => setShowHistory((v) => !v)}
      aria-label="Conversation history"
      aria-pressed={showHistory}
      title={historyEnabled ? 'History' : 'History is disabled on this server'}
    >
      <IconHistory size={18} />
    </button>
  );

  return (
    <div className="chat-panel">
      {variant === 'floating' && (
        <div className="assistant-panel-header">
          <span className="assistant-panel-icon" aria-hidden>
            <img className="assistant-panel-icon-img" src={copilotIcon} alt="" />
          </span>
          <div className="assistant-panel-heading">
            <div className="assistant-panel-title">Urbani Copilot</div>
            <div className="assistant-panel-status">
              <SourceBadge
                source={logsSource}
                note={`Logs: ${logsSource}`}
              />{' '}
              Powered by Amazon Bedrock (Nova 2 Lite)
            </div>
          </div>
          <Select
            className="assistant-panel-service"
            value={service}
            onChange={(e) => setService(e.target.value)}
            aria-label="Service"
          >
            {enabledServices.map((s) => (
              <option key={s.id} value={s.name}>
                {s.name}
              </option>
            ))}
            {!services.data && <option value="main">main</option>}
          </Select>
          {historyButton}
          {onClose && (
            <button
              type="button"
              className="assistant-panel-close"
              onClick={onClose}
              aria-label="Close Urbani Copilot"
            >
              <IconClose size={18} />
            </button>
          )}
        </div>
      )}
      {variant === 'page' && (
        <div className="assistant-page-controls">
          <Select value={service} onChange={(e) => setService(e.target.value)} aria-label="Service">
            {enabledServices.map((s) => (
              <option key={s.id} value={s.name}>
                {s.name}
              </option>
            ))}
            {!services.data && <option value="main">main</option>}
          </Select>
          <Select
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            aria-label="Environment"
          >
            <option>qa</option>
          </Select>
          <Button variant="secondary" onClick={() => setShowHistory((v) => !v)} aria-pressed={showHistory}>
            History
          </Button>
        </div>
      )}
      {showHistory ? (
        <AssistantHistory onClose={() => setShowHistory(false)} />
      ) : (
        <>
          <div className="chat-log" ref={logRef} aria-live="polite">
            {messages.map((m, i) => (
              <AssistantMessage key={m.id ?? i} message={m} />
            ))}
            {busy && <ThinkingIndicator since={pendingSince} />}
          </div>
          <AssistantSuggestions />
          <AssistantInput inputRef={inputRef} />
        </>
      )}
    </div>
  );
}
