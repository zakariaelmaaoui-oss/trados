// Builds the app once per process (or per serverless instance).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { loadVapid, createSender } from './services/push.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function bootstrap({ env = process.env, serveStatic = true } = {}) {
  const onVercel = !!env.VERCEL;
  if (onVercel && !(env.DATABASE_URL || env.POSTGRES_URL)) throw new Error('DATABASE_URL is not set: connect a Neon Postgres database to this Vercel project.');
  const db = await openDb({ url: env.DATABASE_URL || env.POSTGRES_URL, dir: env.DATABASE_URL || env.POSTGRES_URL ? undefined : path.resolve(env.DATA_DIR || path.join(ROOT, 'data'), 'pg') });
  const vapid = await loadVapid(db, env);
  const sender = createSender(vapid, { proxy: env.PUSH_PROXY || undefined });
  const app = createApp(db, {
    publicDir: serveStatic ? path.join(ROOT, 'dist') : null,
    vapid, sender,
    secureCookies: onVercel || env.COOKIE_SECURE === '1',
    trustProxy: onVercel ? true : 'loopback',
    cronSecret: env.CRON_SECRET || null,
  });
  return { app, db, vapid, sender };
}
