import { SourceBadge } from '../ui';
import type { AssistantMessageData } from './useAssistantChat';
import copilotIcon from '../../assets/copilot-icon.png';

/**
 * Renders one chat message — user/assistant bubble, citations, provenance meta,
 * and error state — using the existing `.chat-*` design-system classes. Markup
 * is extracted verbatim from the original Assistant page so there is no second
 * rendering implementation. Only citations present on the response are shown
 * (NO EVIDENCE / NO_ANOMALY_DETECTED text is preserved exactly as returned).
 */
export function AssistantMessage({ message }: { message: AssistantMessageData }) {
  const { role, content, citations, meta, source, isError } = message;
  return (
    <div className={`chat-msg ${role}`}>
      <div className={`chat-avatar ${role}`} aria-hidden>
        {role === 'assistant' ? <img className="chat-avatar-img" src={copilotIcon} alt="" /> : 'You'}
      </div>
      <div>
        <div className={`chat-bubble ${isError ? 'is-error' : ''}`}>{content}</div>
        {citations && citations.length > 0 && (
          <div className="chat-citations">
            {citations.map((c, j) => (
              <div className="cite" key={j}>{c}</div>
            ))}
          </div>
        )}
        {meta && (
          <div className="chat-meta">
            {source && (
              <SourceBadge source={source as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION'} />
            )}{' '}
            {meta}
          </div>
        )}
      </div>
    </div>
  );
}
