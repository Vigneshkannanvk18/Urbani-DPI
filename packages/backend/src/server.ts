import { createApp } from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { runMigrations } from './db/migrate';

/** Server bootstrap. Applies pending migrations then starts listening. */
function main(): void {
  runMigrations();
  const app = createApp();
  app.listen(config.port, () => {
    logger.info('Urbani Observability API listening', {
      port: config.port,
      env: config.env,
      integrationMode: config.integrationMode,
      baseUrl: config.api.baseUrl,
    });
  });
}

main();
