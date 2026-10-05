import { PageHeader, Card } from '../components/ui';
import { AssistantPanel } from '../components/assistant/AssistantPanel';

/**
 * AI Log Chatbot page (Assistant). Ask natural-language questions about the
 * logs; answers are grounded in the current window and are advisory only.
 *
 * This page now reuses the shared AssistantPanel + useAssistantChat hook that
 * also powers the floating widget, so there is exactly one chat implementation.
 * The page sits inside Layout, so it shares the same conversation instance as
 * the floating widget. Service/environment selectors live in the page variant.
 */
export function Assistant() {
  return (
    <div className="stack">
      <PageHeader
        title="AI Log Assistant"
        subtitle="Ask questions about your logs in natural language. Evidence-grounded and advisory — no automated actions."
        source="MOCK"
        note="Answers via MockAIProvider in Phase 1; Bedrock later with no UI change."
      />

      <Card>
        <AssistantPanel variant="page" />
      </Card>
    </div>
  );
}
