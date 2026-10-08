import { SourceBadge } from '../ui';
import type { AssistantMessageData } from './useAssistantChat';
import { renderMarkdown } from './markdown';
import copilotIcon from '../../assets/copilot-icon.png';

/**
 * Renders one chat message — user/assistant bubble, citations, provenance meta,
 * and error state — using the existing `.chat-*` design-system classes. Markup
 * is extracted verbatim from the original Assistant page so there is no second
 * rendering implementation. Only citations present on the response are shown
 * (NO EVIDENCE / NO_ANOMALY_DETECTED text is preserved exactly as returned).
 */
export function AssistantMessage({ message }: { message: AssistantMessageData }) {
  const { role, content, citations, meta, groundingNote, source, isError } = message;
  // Render markdown ONLY for assistant, non-error bubbles (the real Nova 2 Lite
  // answer is markdown). User + error bubbles stay plain text. The renderer is
  // XSS-safe (no dangerouslySetInnerHTML; disallowed URL schemes neutralized).
  const renderMarkdownBody = role === 'assistant' && !isError;
  return (
    <div className={`chat-msg ${role}`}>
      <div className={`chat-avatar ${role}`} aria-hidden>
        {role === 'assistant' ? <img className="chat-avatar-img" src={copilotIcon} alt="" /> : 'You'}
      </div>
      <div>
        <div className={`chat-bubble ${isError ? 'is-error' : ''}`}>
          {renderMarkdownBody ? renderMarkdown(content) : content}
        </div>
        {citations && citations.length > 0 && (
          <div className="chat-citations">
            {citations.map((c, j) => (
              <div className="cite" key={j}>{c}</div>
            ))}
          </div>
        )}
        {groundingNote && !isError && (
          <div className="chat-meta">{groundingNote}</div>
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
