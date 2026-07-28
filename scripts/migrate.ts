import 'dotenv/config';
import { migrateDatabase, closeDatabase } from '../src/storage/database.js';

try {
  const applied = await migrateDatabase();
  process.stdout.write(`${JSON.stringify({ event: 'database.migrated', applied })}\n`);
} finally {
  await closeDatabase();
}
