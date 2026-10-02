import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildApp } from './app';
import { openDatabase } from './db';
import { purgeExpiredAnswers } from './store';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_STATIC_DIR = './dist/client';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.IP ?? process.env.HOST ?? '0.0.0.0';
const dbPath = process.env.DB_PATH ?? './data/funnel.db';
const configsDir = resolve(process.env.CONFIGS_DIR ?? './configs');
const staticDir = process.env.STATIC_DIR ?? (existsSync(DEFAULT_STATIC_DIR) ? DEFAULT_STATIC_DIR : null);

if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
const db = openDatabase(dbPath);
const app = await buildApp({
  db,
  configsDir,
  adminToken: process.env.ADMIN_TOKEN || null,
  staticDir,
  logger: true,
});

function cleanupExpiredSessions(): void {
  const purged = purgeExpiredAnswers(db, new Date().toISOString());
  if (purged > 0) app.log.info({ purged }, 'Purged answers of expired sessions');
}

cleanupExpiredSessions();
const cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Shutting down');
  clearInterval(cleanupTimer);
  await app.close();
  db.close();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port, host });
