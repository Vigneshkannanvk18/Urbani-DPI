import { describe } from 'vitest';
import { defineRepositoryContract } from '../test/repositoryContract';
import { dynamoHarness, sqliteHarness } from '../test/repositoryHarness';

describe('repository contract [sqlite]', () => defineRepositoryContract(sqliteHarness()));

const endpoint = process.env.DYNAMODB_ENDPOINT;
// DynamoDB Local's JVM is slow on its first calls: 20 s per test (hooks: 60 s, set in the contract).
// vitest 2.1.9 accepts the options object as the second argument (SuiteCollectorCallable).
describe.skipIf(!endpoint)('repository contract [dynamodb] (set DYNAMODB_ENDPOINT to run)', { timeout: 20_000 }, () =>
  defineRepositoryContract(dynamoHarness(endpoint!)));
