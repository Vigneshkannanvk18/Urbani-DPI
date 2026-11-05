import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * DynamoDB client context (DPI 2 item 1, design §5.10). Constructing it makes no network call;
 * credentials resolve lazily on the first request.
 */
export interface DynamoContext {
  /** Used only by local tooling and tests (Describe/Create/DeleteTable, Scan purge). */
  client: DynamoDBClient;
  /** Repositories use this exclusively; unit tests inject a recording fake. */
  doc: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
  destroy(): void;
}

export interface DynamoContextOptions {
  region: string;
  /** DynamoDB Local only (DYNAMODB_ENDPOINT). null = the AWS endpoint and the SDK default credential chain. */
  endpoint: string | null;
  tableName: string;
}

export function createDynamoContext({ region, endpoint, tableName }: DynamoContextOptions): DynamoContext {
  const client = new DynamoDBClient({
    region,
    maxAttempts: 3, // SDK standard retry: throttling, 5xx, network
    // throwOnRequestTimeout: without it the handler only logs a warning when requestTimeout is exceeded.
    requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000, throwOnRequestTimeout: true },
    // Dummy credentials only for DynamoDB Local; no real AWS account accepts them.
    ...(endpoint ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
  });
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
    unmarshallOptions: { wrapNumbers: false },
  });
  return { client, doc, tableName, destroy: () => client.destroy() };
}
