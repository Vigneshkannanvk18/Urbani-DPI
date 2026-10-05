import { useEffect, useRef } from 'react';
import { servicesApi } from '../../api/endpoints';
import { useApi } from '../../hooks/useApi';
import { Select, SourceBadge } from '../ui';
import { IconAI, IconClose } from '../icons';
import { useAssistantChat } from './useAssistantChat';
import { AssistantMessage } from './AssistantMessage';
import { AssistantSuggestions } from './AssistantSuggestions';
import { AssistantInput } from './AssistantInput';

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
  const { messages, busy, service, environment, setService, setEnvironment, latestLogsSource } =
    useAssistantChat();
  const logRef = useRef<HTMLDivElement>(null);

  // Service list only needed to populate the page selectors.
  const services = useApi(() => servicesApi.list(), []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  // Honest provenance: logs source from the latest answer, MOCK until first reply.
  const logsSource = (latestLogsSource ?? 'MOCK') as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION';

  return (
    <div className="chat-panel">
      {variant === 'floating' && (
        <div className="assistant-panel-header">
          <span className="assistant-panel-icon" aria-hidden>
            <IconAI size={16} />
          </span>
          <div className="assistant-panel-heading">
            <div className="assistant-panel-title">AI Log Assistant</div>
            <div className="assistant-panel-status">
              <SourceBadge
                source={logsSource}
                note={`Logs: ${logsSource}`}
              />{' '}
              Powered by MockAIProvider · Phase 1
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              className="assistant-panel-close"
              onClick={onClose}
              aria-label="Close AI Log Assistant"
            >
              <IconClose size={18} />
            </button>
          )}
        </div>
      )}

      {variant === 'page' && (
        <div className="assistant-page-controls">
          <Select value={service} onChange={(e) => setService(e.target.value)} aria-label="Service">
            {services.data?.data.map((s) => (
              <option key={s.id} value={s.name}>
                {s.name}
              </option>
            ))}
            {!services.data && <option value="urbani-app">urbani-app</option>}
          </Select>
          <Select
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            aria-label="Environment"
          >
            <option>production-eb</option>
            <option>staging-eb</option>
          </Select>
        </div>
      )}

      <div className="chat-log" ref={logRef} aria-live="polite">
        {messages.map((m, i) => (
          <AssistantMessage key={i} message={m} />
        ))}
        {busy && (
          <div className="chat-msg assistant">
            <div className="chat-avatar assistant" aria-hidden>
              <IconAI size={16} />
            </div>
            <div className="chat-bubble" aria-label="Assistant is typing">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          </div>
        )}
      </div>

      <AssistantSuggestions />
      <AssistantInput inputRef={inputRef} />
    </div>
  );
}
