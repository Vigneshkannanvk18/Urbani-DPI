import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { freshTestDb } from '../test/testDb';
import { setIntegrationsForTesting, resetIntegrations } from '../integrations';
import type { AIProvider, AskLogsResult } from '../integrations/ai/AIProvider';
import type { CloudWatchAdapter } from '../integrations/types';
import { chatService } from './chatService';

/** A minimal fake provider whose note we can assert flows to groundingNote. */
const GROUNDING_NOTE =
  'Live Urbani chat — grounded server-side in 3 recent log window(s) and 2 alert(s).';

const fakeProvider: Pick<AIProvider, 'askLogs' | 'analyzeTelemetry' | 'name' | 'modelId'> = {
  name: 'FakeProvider',
  modelId: 'fake-model',
  async askLogs(): Promise<AskLogsResult> {
    return {
      answer: 'There is one error.',
      citations: [],
      modelId: 'fake-model',
      provider: 'FakeProvider',
      inputTokens: 1,
      outputTokens: 1,
      guardrailIntervened: false,
      meta: { source: 'LIVE', note: GROUNDING_NOTE },
    };
  },
  async analyzeTelemetry() {
    throw new Error('not used');
  },
};

const fakeCloudwatch: Pick<CloudWatchAdapter, 'getLogs' | 'getMetrics' | 'kind'> = {
  kind: 'CLOUDWATCH',
  async getLogs() {
    return { meta: { source: 'LIVE', note: 'window' }, value: [] };
  },
  async getMetrics() {
    return { meta: { source: 'MOCK' }, value: [] };
  },
};

describe('chatService.groundingNote', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshTestDb();
    setIntegrationsForTesting({
      aiProvider: fakeProvider as AIProvider,
      cloudwatch: fakeCloudwatch as CloudWatchAdapter,
    });
  });

  afterEach(() => {
    resetIntegrations();
    db.close();
  });

  it('surfaces the provider grounding note on data.groundingNote', async () => {
    const res = await chatService.ask('Any errors?', { actor: 'tester@urbani.local' });
    expect(res.data.groundingNote).toBe(GROUNDING_NOTE);
    // The envelope sourceNote still carries the same note.
    expect(res.sourceNote).toBe(GROUNDING_NOTE);
  });
});
