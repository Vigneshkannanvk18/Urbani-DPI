import { PageHeader, Card } from '../components/ui';
import { AssistantPanel } from '../components/assistant/AssistantPanel';
import { useAssistantChat } from '../components/assistant/useAssistantChat';

/**
 * AI Log Chatbot page (Assistant). Ask natural-language questions about the
 * logs; answers are grounded in the current window and are advisory only.
 *
 * This page now reuses the shared AssistantPanel + useAssistantChat hook that
 * also powers the floating widget, so there is exactly one chat implementation.
 * The page sits inside Layout, so it shares the same conversation instance as
 * the floating widget. Service/environment selectors live in the page variant.
 *
 * The header source badge reflects the live logs provenance from the latest
 * answer (LIVE when the backend served real AWS logs), not a hardcoded label.
 */
export function Assistant() {
  const { latestLogsSource } = useAssistantChat();
  const headerSource = (latestLogsSource ?? 'LIVE') as 'LIVE' | 'MOCK' | 'WAITING_FOR_INTEGRATION';
  return (
    <div className="stack">
      <PageHeader
        title="Urbani Copilot"
        subtitle="Ask questions about your logs in natural language. Evidence-grounded and advisory — no automated actions."
        source={headerSource}
        note="Answers are grounded in the current log window and cite the evidence used."
      />

      <Card>
        <AssistantPanel variant="page" />
      </Card>
    </div>
  );
}
