import type {
  BedrockAdapter,
  BedrockInvokeParams,
  BedrockInvokeResult,
  WithMeta,
} from '../types';
import { MOCK_NOTE } from './mockData';

/**
 * MockBedrockAdapter (Phase 1). Simulates a deterministic Bedrock invocation
 * WITHOUT calling AWS or incurring token cost. Returns a strict-JSON string that
 * the MockAIProvider parses. Replaced by AWSBedrockAdapter in Phase 3.
 *
 * It also simulates the documented guardrail behaviour: simple PII-like patterns
 * in the prompt are flagged as intervened.
 */
export class MockBedrockAdapter implements BedrockAdapter {
  readonly kind = 'BEDROCK' as const;

  async invokeModel(params: BedrockInvokeParams): Promise<WithMeta<BedrockInvokeResult>> {
    // Rough token estimate purely for cost simulation (chars/4 heuristic).
    const inputTokens = Math.min(Math.ceil(params.prompt.length / 4), 1500);
    const guardrailIntervened =
      /\b(password|secret|token|aws_secret|\d{1,3}(\.\d{1,3}){3})\b/i.test(params.prompt);

    // The MockAIProvider owns the finding shape; this adapter only echoes a
    // placeholder JSON so the boundary matches the real Bedrock text contract.
    const outputText = JSON.stringify({ status: 'MOCK_INVOCATION', modelId: params.modelId });

    const result: BedrockInvokeResult = {
      outputText,
      modelId: params.modelId,
      inputTokens,
      outputTokens: Math.min(Math.ceil(outputText.length / 4), params.maxTokens),
      guardrailIntervened,
    };
    return { meta: { source: 'MOCK', note: MOCK_NOTE }, value: result };
  }
}
