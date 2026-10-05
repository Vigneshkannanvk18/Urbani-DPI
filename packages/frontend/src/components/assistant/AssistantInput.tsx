import { useState, type KeyboardEvent, type Ref } from 'react';
import { Button } from '../ui';
import { useAssistantChat } from './useAssistantChat';

/**
 * Chat composer: a multiline textarea with Enter-to-send and Shift+Enter for a
 * newline, disabled while a request is in flight, and a send button guarded
 * against empty/duplicate submission. Reads `busy`/`send` from the shared hook.
 */
export function AssistantInput({ inputRef }: { inputRef?: Ref<HTMLTextAreaElement> }) {
  const { busy, send } = useAssistantChat();
  const [input, setInput] = useState('');

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return; // duplicate-submit / empty guard
    setInput('');
    void send(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="chat-input-row"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={inputRef}
        className="input assistant-textarea"
        placeholder="Ask about the logs…"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Ask about the logs"
        rows={1}
        disabled={busy}
      />
      <Button type="submit" disabled={busy || !input.trim()}>
        Send
      </Button>
    </form>
  );
}
