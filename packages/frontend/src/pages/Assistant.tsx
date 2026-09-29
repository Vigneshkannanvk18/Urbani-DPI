import { useRef, useState, useEffect } from 'react';
import { chatApi, servicesApi, type ChatTurn } from '../api/endpoints';
import { useApi } from '../hooks/useApi';
import { PageHeader, Card, Button, Select, SourceBadge } from '../components/ui';
import { IconAI } from '../components/icons';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  citations?: string[];
  meta?: string;
  source?: string;
}

const SUGGESTIONS = [
  'Summarize the current logs',
  'Are there any errors right now?',
  'How many log lines are in this window?',
  'What should I investigate next?',
];

/** AI Log Chatbot page (Assistant). Ask natural-language questions about the
 *  logs; answers are grounded in the current window and are advisory only. */
export function Assistant() {
  const services = useApi(() => servicesApi.list(), []);
  const [service, setService] = useState('urbani-app');
  const [environment, setEnvironment] = useState('production-eb');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content:
        'Hi — I\'m the Urbani log assistant. Ask me anything about the current logs and I\'ll answer ' +
        'from the evidence in the latest window. I\'m advisory only and never take any action.',
    },
  ]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setInput('');
    const history: ChatTurn[] = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: 'user', content: question }]);
    setBusy(true);
    try {
      const res = await chatApi.ask(question, { service, environment, history });
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: res.data.answer,
          citations: res.data.citations,
          source: res.data.logsSource,
          meta: `${res.data.provider} · ${res.data.modelId}`,
        },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: `Sorry — I couldn't answer that. ${err instanceof Error ? err.message : ''}` },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <PageHeader
        title="AI Log Assistant"
        subtitle="Ask questions about your logs in natural language. Evidence-grounded and advisory — no automated actions."
        source="MOCK"
        note="Answers via MockAIProvider in Phase 1; Bedrock later with no UI change."
        actions={
          <div className="row gap-2">
            <Select value={service} onChange={(e) => setService(e.target.value)} aria-label="Service">
              {services.data?.data.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
              {!services.data && <option value="urbani-app">urbani-app</option>}
            </Select>
            <Select value={environment} onChange={(e) => setEnvironment(e.target.value)} aria-label="Environment">
              <option>production-eb</option>
              <option>staging-eb</option>
            </Select>
          </div>
        }
      />

      <Card>
        <div className="chat-panel">
          <div className="chat-log" ref={logRef} aria-live="polite">
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}`}>
                <div className={`chat-avatar ${m.role}`} aria-hidden>
                  {m.role === 'assistant' ? <IconAI size={16} /> : 'You'}
                </div>
                <div>
                  <div className="chat-bubble">{m.content}</div>
                  {m.citations && m.citations.length > 0 && (
                    <div className="chat-citations">
                      {m.citations.map((c, j) => <div className="cite" key={j}>{c}</div>)}
                    </div>
                  )}
                  {m.meta && (
                    <div className="chat-meta">
                      {m.source && <SourceBadge source={m.source as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION'} />} {m.meta}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="chat-msg assistant">
                <div className="chat-avatar assistant" aria-hidden><IconAI size={16} /></div>
                <div className="chat-bubble" aria-label="Assistant is typing">
                  <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
                </div>
              </div>
            )}
          </div>

          <div className="chat-suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chat-chip" onClick={() => send(s)} disabled={busy}>{s}</button>
            ))}
          </div>

          <form
            className="chat-input-row"
            onSubmit={(e) => { e.preventDefault(); send(input); }}
          >
            <input
              className="input"
              placeholder="Ask about the logs…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label="Ask about the logs"
              disabled={busy}
            />
            <Button type="submit" disabled={busy || !input.trim()}>Send</Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
