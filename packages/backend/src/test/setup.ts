/**
 * Vitest setup. Provides deterministic env config BEFORE the config module is
 * imported, so tests never depend on a local .env file.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-value-not-for-production';
process.env.INTEGRATION_MODE = 'mock';
process.env.DB_SQLITE_PATH = ':memory:';
process.env.LOG_LEVEL = 'error';
