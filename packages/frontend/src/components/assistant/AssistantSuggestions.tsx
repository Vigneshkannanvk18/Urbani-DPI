import { useAssistantChat } from './useAssistantChat';

/** Recommended starter prompts — all route through the one `/api/chat` path. */
const SUGGESTIONS = [
  'Are there any errors right now?',
  'Summarize the current logs',
  'What should I investigate next?',
  'Show recent warnings',
  'What is the most suspicious log?',
];

/** Suggestion chips reusing the existing `.chat-suggestions`/`.chat-chip` CSS. */
export function AssistantSuggestions() {
  const { busy, send } = useAssistantChat();
  return (
    <div className="chat-suggestions">
      {SUGGESTIONS.map((s) => (
        <button
          key={s}
          type="button"
          className="chat-chip"
          onClick={() => void send(s)}
          disabled={busy}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
