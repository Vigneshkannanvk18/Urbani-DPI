import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { chatApi, type ApiRating, type ChatStoredMessage, type ChatTurn } from '../../api/endpoints';
import { ApiClientError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';

/** One chat message rendered in both the full page and the floating widget. */
export interface AssistantMessageData {
  role: 'user' | 'assistant';
  content: string;
  citations?: string[];
  meta?: string;
  /** Honest grounding note under the answer (may draw on alerts, not just logs). */
  groundingNote?: string;
  source?: string;
  isError?: boolean;
  /** Opaque server id; present only when the answer was stored (needed for feedback). */
  id?: string;
  feedback?: { rating: ApiRating; comment: string | null } | null;
  /** End-to-end timing from the API; absent on old data (nothing is shown then). */
  latencyMs?: { totalMs: number; providerMs: number | null } | null;
}

/** Honest copy for a 503/unavailable turn or a transport failure (no internals). */
const API_ERROR_MESSAGE = 'Urbani Copilot is temporarily unavailable. Please try again.';

/** Initial greeting — identical to the long-standing Assistant page copy. */
const INITIAL_MESSAGES: AssistantMessageData[] = [
  {
    role: 'assistant',
    content:
      'Hi — I\'m Urbani Copilot, your observability assistant. Ask me anything about the current ' +
      'logs and I\'ll answer from the evidence in the latest window. I\'m advisory only and never ' +
      'take any action.',
  },
];

const lastSessionKey = (userId: string) => `urbani.chat.lastSession.${userId}`;

function fromStored(m: ChatStoredMessage): AssistantMessageData {
  return {
    role: m.role,
    content: m.content,
    citations: m.citations,
    source: m.isError ? undefined : (m.source ?? undefined),
    meta: m.provider ? `${m.provider} · ${m.modelId ?? ''}` : undefined,
    groundingNote: m.groundingNote ?? undefined,
    isError: m.isError,
    id: m.role === 'assistant' && !m.isError ? m.id : undefined,
    feedback: m.feedback,
    latencyMs: m.latencyMs,
  };
}

interface AssistantChatValue {
  messages: AssistantMessageData[];
  busy: boolean;
  error: string | null;
  service: string;
  environment: string;
  setService: (s: string) => void;
  setEnvironment: (e: string) => void;
  send: (text: string) => Promise<void>;
  /** logsSource from the most recent assistant answer, for the widget header. */
  latestLogsSource: string | null;
  /** provider from the most recent assistant answer, for the widget header. */
  latestProvider: string | null;
  /** DPI 2 item 8: current stored conversation (null = new chat). */
  sessionId: string | null;
  /** false once the server says CHAT_HISTORY_ENABLED=false. */
  historyEnabled: boolean;
  newChat: () => void;
  openSession: (id: string) => Promise<boolean>;
  /** The open session was renamed/deleted elsewhere (history panel). */
  sessionRemoved: (id: string) => void;
  /** Optimistic like/dislike with rollback; rating null clears. */
  rate: (messageId: string, rating: ApiRating | null, comment?: string) => Promise<void>;
  feedbackError: string | null;
  /** performance.now() when the pending question was sent (null when idle). */
  pendingSince: number | null;
}

const AssistantChatContext = createContext<AssistantChatValue | null>(null);

/**
 * Single source of chat behavior. Owns messages/busy/error/service/environment
 * and the one `chatApi.ask()` call. Mounted once in the authenticated shell so
 * the conversation survives panel close/reopen and navigation during a session,
 * and is torn down on logout when the shell unmounts.
 *
 * DPI 2 item 8: the conversation is also stored server-side per user. The id of the
 * last open session is remembered in localStorage and resumed on reload.
 */
export function AssistantChatProvider({ children }: { children: ReactNode }) {
  const { user, can } = useAuth();
  const userId = user?.id ?? null;
  const [service, setService] = useState('main');
  const [environment, setEnvironment] = useState('qa');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessageData[]>(INITIAL_MESSAGES);
  const [latestLogsSource, setLatestLogsSource] = useState<string | null>(null);
  const [latestProvider, setLatestProvider] = useState<string | null>(null);
  const [sessionId, setSessionIdState] = useState<string | null>(null);
  const [historyEnabled, setHistoryEnabled] = useState(true);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const resumed = useRef(false);

  const setSessionId = useCallback(
    (id: string | null) => {
      setSessionIdState(id);
      if (!userId) return;
      try {
        if (id) localStorage.setItem(lastSessionKey(userId), id);
        else localStorage.removeItem(lastSessionKey(userId));
      } catch {
        /* storage unavailable: resume simply will not work */
      }
    },
    [userId],
  );

  const newChat = useCallback(() => {
    setSessionId(null);
    setMessages(INITIAL_MESSAGES);
    setError(null);
    setFeedbackError(null);
  }, [setSessionId]);

  const openSession = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await chatApi.session(id);
        const { session, messages: stored } = res.data;
        setMessages(stored.length ? stored.map(fromStored) : INITIAL_MESSAGES);
        if (session.service) setService(session.service);
        if (session.environment) setEnvironment(session.environment);
        setSessionId(session.id);
        setError(null);
        setFeedbackError(null);
        return true;
      } catch (e) {
        // A deleted/foreign session (404) is tolerated: forget it and stay on a new chat.
        if (e instanceof ApiClientError && e.status === 404) setSessionId(null);
        if (e instanceof ApiClientError && e.code === 'CHAT_HISTORY_DISABLED') setHistoryEnabled(false);
        return false;
      }
    },
    [setSessionId],
  );

  // Resume the last open conversation once per signed-in user; also learn whether history is enabled.
  useEffect(() => {
    if (!userId || resumed.current || !can('chat:use')) return;
    resumed.current = true;
    chatApi
      .sessions()
      .then((r) => setHistoryEnabled(r.data.historyEnabled))
      .catch(() => undefined);
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(lastSessionKey(userId));
    } catch {
      saved = null;
    }
    if (saved) void openSession(saved);
  }, [userId, can, openSession]);

  const sessionRemoved = useCallback(
    (id: string) => {
      if (id === sessionId) newChat();
    },
    [sessionId, newChat],
  );

  const send = async (text: string) => {
    const question = text.trim();
    // Duplicate-submit guard: ignore empty input and sends while busy.
    if (!question || busy) return;
    const history: ChatTurn[] = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: 'user', content: question }]);
    setBusy(true);
    setError(null);
    setPendingSince(performance.now());
    try {
      const res = await chatApi.ask(question, { service, environment, history, sessionId: sessionId ?? undefined });
      setLatestLogsSource(res.data.logsSource);
      setLatestProvider(res.data.provider);
      if (res.data.historyEnabled !== undefined) setHistoryEnabled(res.data.historyEnabled);
      if (res.data.sessionId) setSessionId(res.data.sessionId);
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: res.data.answer,
          citations: res.data.citations,
          // AC16: the per-answer badge reflects the ANSWER provenance (res.source),
          // not the log-window grounding source, so a MOCK/unavailable turn is
          // never shown with a LIVE badge.
          source: res.source,
          meta: `${res.data.provider} · ${res.data.modelId}`,
          groundingNote: res.data.groundingNote,
          id: res.data.assistantMessageId ?? undefined,
          feedback: null,
          latencyMs: res.data.latencyMs ? { ...res.data.latencyMs } : null,
        },
      ]);
    } catch (e) {
      // Professional, generic failure — never expose stack traces or secrets.
      let message = API_ERROR_MESSAGE;
      if (e instanceof ApiClientError) {
        const details = e.details as { sessionId?: string } | undefined;
        // The failed turn was stored: keep following the same conversation.
        if (details?.sessionId) setSessionId(details.sessionId);
        if (e.status === 404) {
          // The stored conversation is gone (deleted elsewhere): start a new one next time.
          setSessionId(null);
          message = 'That conversation is no longer available. Your next question starts a new chat.';
        }
      }
      setError(message);
      setMessages((m) => [...m, { role: 'assistant', content: message, isError: true }]);
    } finally {
      setBusy(false);
      setPendingSince(null);
    }
  };

  const rate = useCallback(
    async (messageId: string, rating: ApiRating | null, comment?: string) => {
      let previous: AssistantMessageData['feedback'] = null;
      const apply = (fb: AssistantMessageData['feedback']) =>
        setMessages((all) => all.map((m) => (m.id === messageId ? { ...m, feedback: fb } : m)));
      setMessages((all) => {
        previous = all.find((m) => m.id === messageId)?.feedback ?? null;
        return all.map((m) =>
          m.id === messageId
            ? { ...m, feedback: rating ? { rating, comment: comment ?? (previous?.comment ?? null) } : null }
            : m,
        );
      });
      setFeedbackError(null);
      try {
        await chatApi.feedback(messageId, rating, comment);
      } catch (e) {
        apply(previous); // rollback
        if (e instanceof ApiClientError && e.code === 'CHAT_HISTORY_DISABLED') setHistoryEnabled(false);
        setFeedbackError('Could not save your feedback. Please try again.');
      }
    },
    [],
  );

  const value = useMemo<AssistantChatValue>(
    () => ({
      messages,
      busy,
      error,
      service,
      environment,
      setService,
      setEnvironment,
      send,
      latestLogsSource,
      latestProvider,
      sessionId,
      historyEnabled,
      newChat,
      openSession,
      sessionRemoved,
      rate,
      feedbackError,
      pendingSince,
    }),
    // `send` closes over current state; recompute when any input changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, busy, error, service, environment, latestLogsSource, latestProvider, sessionId, historyEnabled, feedbackError, pendingSince, newChat, openSession, sessionRemoved, rate],
  );

  return <AssistantChatContext.Provider value={value}>{children}</AssistantChatContext.Provider>;
}

/** Consume the shared chat engine. Must be used within AssistantChatProvider. */
export function useAssistantChat(): AssistantChatValue {
  const ctx = useContext(AssistantChatContext);
  if (!ctx) {
    throw new Error('useAssistantChat must be used within an AssistantChatProvider');
  }
  return ctx;
}
