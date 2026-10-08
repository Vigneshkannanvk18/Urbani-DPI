import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { chatApi, type ChatTurn } from '../../api/endpoints';

/** One chat message rendered in both the full page and the floating widget. */
export interface AssistantMessageData {
  role: 'user' | 'assistant';
  content: string;
  citations?: string[];
  meta?: string;
  source?: string;
  isError?: boolean;
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
}

const AssistantChatContext = createContext<AssistantChatValue | null>(null);

/**
 * Single source of chat behavior. Owns messages/busy/error/service/environment
 * and the one `chatApi.ask()` call. Mounted once in the authenticated shell so
 * the conversation survives panel close/reopen and navigation during a session,
 * and is torn down on logout when the shell unmounts.
 */
export function AssistantChatProvider({ children }: { children: ReactNode }) {
  const [service, setService] = useState('main');
  const [environment, setEnvironment] = useState('qa');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessageData[]>(INITIAL_MESSAGES);
  const [latestLogsSource, setLatestLogsSource] = useState<string | null>(null);
  const [latestProvider, setLatestProvider] = useState<string | null>(null);

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
    try {
      const res = await chatApi.ask(question, { service, environment, history });
      setLatestLogsSource(res.data.logsSource);
      setLatestProvider(res.data.provider);
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
        },
      ]);
    } catch {
      // Professional, generic failure — never expose stack traces or secrets.
      setError(API_ERROR_MESSAGE);
      setMessages((m) => [...m, { role: 'assistant', content: API_ERROR_MESSAGE, isError: true }]);
    } finally {
      setBusy(false);
    }
  };

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
    }),
    // `send` closes over current state; recompute when any input changes.
    [messages, busy, error, service, environment, latestLogsSource, latestProvider],
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
