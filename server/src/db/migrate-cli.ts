import 'dotenv/config';
import { loadConfig } from '../config';
import { runMigrations } from './migrate';

runMigrations(loadConfig())
  .then(() => {
    process.stdout.write('Database migrations complete.\n');
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
