import { useState } from 'react';
import { SourceBadge } from '../ui';
import { IconThumbDown, IconThumbUp } from '../icons';
import { useAssistantChat, type AssistantMessageData } from './useAssistantChat';
import { renderMarkdown } from './markdown';
import copilotIcon from '../../assets/copilot-icon.png';

/** A response slower than this gets the subtle "slow" style. */
export const SLOW_ANSWER_MS = 10_000;

/** "3.2 s" — one decimal below a minute. */
export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`;
}

/**
 * Renders one chat message — user/assistant bubble, citations, provenance meta,
 * and error state — using the existing `.chat-*` design-system classes. Markup
 * is extracted verbatim from the original Assistant page so there is no second
 * rendering implementation. Only citations present on the response are shown
 * (NO EVIDENCE / NO_ANOMALY_DETECTED text is preserved exactly as returned).
 *
 * DPI 2 items 8-9: thumbs up/down (optimistic, rollback on failure, optional comment
 * after thumbs-down) and the end-to-end latency line. No latency from the API = nothing shown.
 */
export function AssistantMessage({ message }: { message: AssistantMessageData }) {
  const { role, content, citations, meta, groundingNote, source, isError, id, feedback, latencyMs } = message;
  const { rate, historyEnabled, feedbackError } = useAssistantChat();
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState('');
  // Render markdown ONLY for assistant, non-error bubbles (the real Nova 2 Lite
  // answer is markdown). User + error bubbles stay plain text. The renderer is
  // XSS-safe (no dangerouslySetInnerHTML; disallowed URL schemes neutralized).
  const renderMarkdownBody = role === 'assistant' && !isError;
  const canRate = role === 'assistant' && !isError && Boolean(meta); // not the greeting
  const rateDisabled = !historyEnabled || !id;
  const disabledReason = !historyEnabled
    ? 'Feedback is not stored because chat history is disabled.'
    : 'This answer was not saved, so it cannot be rated.';
  const slow = latencyMs ? latencyMs.totalMs > SLOW_ANSWER_MS : false;

  const toggle = (value: 'UP' | 'DOWN') => {
    if (!id || rateDisabled) return;
    if (feedback?.rating === value) {
      setCommentOpen(false);
      void rate(id, null);
      return;
    }
    void rate(id, value);
    setCommentOpen(value === 'DOWN');
  };
  const sendComment = () => {
    if (!id || !comment.trim()) return;
    void rate(id, 'DOWN', comment.trim());
    setCommentOpen(false);
    setComment('');
  };

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
        {latencyMs && role === 'assistant' && (
          <div
            className={`chat-latency ${slow ? 'is-slow' : ''}`}
            title="Includes the Urbani /chat round trip, not just the model."
          >
            Answered in {formatSeconds(latencyMs.totalMs)}
            {slow ? ' (slow)' : ''}
          </div>
        )}
        {canRate && (
          <div className="chat-feedback" role="group" aria-label="Rate this answer">
            <button
              type="button"
              className={`chat-feedback-btn ${feedback?.rating === 'UP' ? 'is-active' : ''}`}
              aria-label="Good answer"
              aria-pressed={feedback?.rating === 'UP'}
              disabled={rateDisabled}
              title={rateDisabled ? disabledReason : 'Good answer'}
              onClick={() => toggle('UP')}
            >
              <IconThumbUp size={14} />
            </button>
            <button
              type="button"
              className={`chat-feedback-btn ${feedback?.rating === 'DOWN' ? 'is-active is-down' : ''}`}
              aria-label="Bad answer"
              aria-pressed={feedback?.rating === 'DOWN'}
              disabled={rateDisabled}
              title={rateDisabled ? disabledReason : 'Bad answer'}
              onClick={() => toggle('DOWN')}
            >
              <IconThumbDown size={14} />
            </button>
            {feedback?.rating === 'DOWN' && !commentOpen && (
              <button type="button" className="chat-feedback-link" onClick={() => setCommentOpen(true)}>
                {feedback.comment ? 'Edit comment' : 'Add a comment'}
              </button>
            )}
            {feedbackError && <span className="chat-feedback-error" role="alert">{feedbackError}</span>}
          </div>
        )}
        {canRate && commentOpen && (
          <div className="chat-feedback-comment">
            <label className="sr-only" htmlFor={`fb-${id}`}>What was wrong with this answer?</label>
            <textarea
              id={`fb-${id}`}
              className="input"
              rows={2}
              maxLength={500}
              placeholder="What was wrong? (optional, max 500 characters; do not include secrets)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="chat-feedback-comment-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={sendComment} disabled={!comment.trim()}>
                Send
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCommentOpen(false)}>
                Skip
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
