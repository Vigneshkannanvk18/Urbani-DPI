import { useCallback, useEffect, useState } from 'react';
import { chatApi, type ChatSessionSummary } from '../../api/endpoints';
import { Button } from '../ui';
import { useAssistantChat } from './useAssistantChat';

/** "3 min ago", "2 h ago", "5 d ago", else the date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d} d ago` : new Date(iso).toLocaleDateString();
}

/**
 * Conversation history (DPI 2 item 8): the signed-in user's own previous sessions.
 * Open resumes (loads messages, restores service/environment, continues the same session id),
 * Rename edits the title, Delete asks for confirmation then removes the session for good.
 */
export function AssistantHistory({ onClose }: { onClose: () => void }) {
  const { openSession, newChat, sessionId, sessionRemoved, historyEnabled } = useAssistantChat();
  const [items, setItems] = useState<ChatSessionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async (next?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await chatApi.sessions(next);
      setItems((cur) => (next ? [...cur, ...res.data.items] : res.data.items));
      setCursor(res.data.nextCursor);
    } catch {
      setError('Could not load your conversations.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string) => {
    if (await openSession(id)) onClose();
    else {
      setError('That conversation is no longer available.');
      void load();
    }
  };
  const saveTitle = async (id: string) => {
    const t = title.trim();
    if (!t) return;
    try {
      const res = await chatApi.rename(id, t);
      setItems((cur) => cur.map((s) => (s.id === id ? { ...s, title: res.data.title } : s)));
      setEditing(null);
    } catch {
      setError('Could not rename the conversation.');
    }
  };
  const remove = async (id: string) => {
    try {
      await chatApi.remove(id);
      setItems((cur) => cur.filter((s) => s.id !== id));
      sessionRemoved(id);
    } catch {
      setError('Could not delete the conversation.');
    } finally {
      setConfirming(null);
    }
  };

  return (
    <section className="assistant-history" aria-label="Conversation history">
      <div className="assistant-history-head">
        <strong>History</strong>
        <div className="assistant-history-actions">
          <Button
            size="sm"
            onClick={() => {
              newChat();
              onClose();
            }}
          >
            New chat
          </Button>
          <Button size="sm" variant="secondary" onClick={onClose}>
            Back to chat
          </Button>
        </div>
      </div>
      {!historyEnabled && (
        <p className="text-secondary" role="status">
          Chat history is disabled on this server, so conversations are not saved.
        </p>
      )}
      {error && <p className="chat-feedback-error" role="alert">{error}</p>}
      {historyEnabled && !loading && items.length === 0 && !error && (
        <p className="text-secondary">No saved conversations yet.</p>
      )}
      <ul className="assistant-history-list">
        {items.map((s) => (
          <li key={s.id} className={`assistant-history-item ${s.id === sessionId ? 'is-current' : ''}`}>
            {editing === s.id ? (
              <form
                className="assistant-history-rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveTitle(s.id);
                }}
              >
                <input
                  className="input"
                  aria-label="Conversation title"
                  value={title}
                  maxLength={200}
                  autoFocus
                  onChange={(e) => setTitle(e.target.value)}
                />
                <Button size="sm" type="submit" disabled={!title.trim()}>Save</Button>
                <Button size="sm" variant="secondary" type="button" onClick={() => setEditing(null)}>Cancel</Button>
              </form>
            ) : (
              <>
                <button type="button" className="assistant-history-open" onClick={() => void open(s.id)} aria-label={`Open conversation ${s.title ?? 'Untitled'}`}>
                  <span className="assistant-history-title">{s.title ?? 'Untitled'}</span>
                  <span className="assistant-history-meta">
                    {relativeTime(s.updatedAt)} · {s.service ?? 'n/a'} · {s.messageCount} message{s.messageCount === 1 ? '' : 's'}
                  </span>
                </button>
                {confirming === s.id ? (
                  <span className="assistant-history-confirm" role="alertdialog" aria-label="Confirm delete">
                    Delete for good?
                    <Button size="sm" variant="primary" onClick={() => void remove(s.id)}>Delete</Button>
                    <Button size="sm" variant="secondary" onClick={() => setConfirming(null)}>Keep</Button>
                  </span>
                ) : (
                  <span className="assistant-history-row-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`Rename ${s.title ?? 'conversation'}`}
                      onClick={() => {
                        setEditing(s.id);
                        setTitle(s.title ?? '');
                      }}
                    >
                      Rename
                    </Button>
                    <Button size="sm" variant="secondary" aria-label={`Delete ${s.title ?? 'conversation'}`} onClick={() => setConfirming(s.id)}>
                      Delete
                    </Button>
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {loading && <p className="text-secondary" role="status">Loading…</p>}
      {cursor && !loading && (
        <Button size="sm" variant="secondary" onClick={() => void load(cursor)}>Load more</Button>
      )}
    </section>
  );
}
