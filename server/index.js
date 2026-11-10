import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { loadVapid, createSender } from './services/push.js';
import { startScheduler } from './scheduler.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const db = openDb(path.join(dataDir, 'tradeos.db'));
const vapid = loadVapid(db);
const sender = createSender(vapid, { proxy: process.env.PUSH_PROXY || undefined });

const app = createApp(db, {
  dataDir,
  publicDir: path.join(root, 'dist'),
  vapid,
  sender,
  secureCookies: process.env.COOKIE_SECURE === '1',
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`TradeOS listening on http://${host}:${port}`);
  if (process.env.DISABLE_SCHEDULER !== '1') startScheduler(db, { send: sender });
});
