import { describe } from 'vitest';
import { defineRepositoryContract } from '../test/repositoryContract';
import { sqliteHarness } from '../test/repositoryHarness';

describe('repository contract [sqlite]', () => defineRepositoryContract(sqliteHarness()));
