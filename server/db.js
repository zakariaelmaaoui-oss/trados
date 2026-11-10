// SQLite persistence layer (Node built-in node:sqlite, no native build step).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  default_risk_pct REAL NOT NULL DEFAULT 1.0,
  timezone TEXT NOT NULL DEFAULT 'Africa/Casablanca',
  active_mode TEXT NOT NULL DEFAULT 'demo' CHECK (active_mode IN ('demo','live')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Trading accounts. Demo and Live are separated at the account level; every
-- trade belongs to exactly one account and statistics are always filtered by type.
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('demo','live')),
  broker TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  starting_balance REAL NOT NULL DEFAULT 0,
  server_utc_offset_min INTEGER NOT NULL DEFAULT 120,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ticket TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','mt5_csv')),
  import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('buy','sell')),
  volume REAL NOT NULL CHECK (volume > 0),
  open_time TEXT NOT NULL,          -- UTC ISO-8601
  close_time TEXT,                  -- UTC ISO-8601, NULL = open trade
  open_price REAL NOT NULL,
  close_price REAL,
  stop_loss REAL,
  take_profit REAL,
  commission REAL NOT NULL DEFAULT 0,
  swap REAL NOT NULL DEFAULT 0,
  profit REAL,                      -- gross profit in account currency
  risk_pct REAL NOT NULL DEFAULT 1.0,
  risk_amount REAL,
  setup TEXT,
  plan_followed INTEGER CHECK (plan_followed IN (0,1)),
  emotion TEXT,
  notes TEXT,
  corrected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (account_id, ticket)
);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id, open_time);

CREATE TABLE IF NOT EXISTS trade_screenshots (
  id INTEGER PRIMARY KEY,
  trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('before','after')),
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  rows_total INTEGER NOT NULL,
  rows_imported INTEGER NOT NULL,
  rows_duplicate INTEGER NOT NULL,
  rows_invalid INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Planner ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_plans (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_date TEXT NOT NULL,          -- YYYY-MM-DD in the user's timezone
  market_bias TEXT,
  key_levels TEXT,
  pairs_to_watch TEXT,
  news_to_watch TEXT,
  goals TEXT,
  max_trades INTEGER,
  max_daily_loss_pct REAL,
  mental_state INTEGER CHECK (mental_state BETWEEN 1 AND 5),
  -- post-session review
  review_followed_plan INTEGER CHECK (review_followed_plan IN (0,1)),
  review_went_well TEXT,
  review_mistakes TEXT,
  review_lessons TEXT,
  review_rating INTEGER CHECK (review_rating BETWEEN 1 AND 5),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, plan_date)
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS checklist_checks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  check_date TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (item_id, check_date)
);

CREATE TABLE IF NOT EXISTS trading_rules (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- Which rules were followed/broken on a given day (filled in the post-session review).
CREATE TABLE IF NOT EXISTS rule_adherence (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id INTEGER NOT NULL REFERENCES trading_rules(id) ON DELETE CASCADE,
  review_date TEXT NOT NULL,
  followed INTEGER NOT NULL CHECK (followed IN (0,1)),
  PRIMARY KEY (rule_id, review_date)
);

CREATE TABLE IF NOT EXISTS weekly_reviews (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,         -- Monday, YYYY-MM-DD
  what_worked TEXT,
  what_didnt TEXT,
  improvements TEXT,
  focus_next_week TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, week_start)
);

-- Economic calendar ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS econ_events (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,         -- provider-stable dedupe key
  provider TEXT NOT NULL,
  title TEXT NOT NULL,
  currency TEXT NOT NULL,
  impact TEXT NOT NULL,             -- high | medium | low | holiday
  scheduled_at TEXT NOT NULL,       -- UTC ISO-8601
  all_day INTEGER NOT NULL DEFAULT 0,
  forecast TEXT,
  previous TEXT,
  actual TEXT,                      -- only set when the provider supplies it
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_seen_fetch_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1 -- 0 = no longer listed by provider (rescheduled/removed)
);
CREATE INDEX IF NOT EXISTS idx_events_time ON econ_events(scheduled_at);

CREATE TABLE IF NOT EXISTS calendar_fetches (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  events_received INTEGER,
  events_new INTEGER,
  window_start TEXT,
  window_end TEXT,
  error TEXT
);

-- Notifications -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  impact_high INTEGER NOT NULL DEFAULT 1,
  impact_medium INTEGER NOT NULL DEFAULT 1,
  impact_low INTEGER NOT NULL DEFAULT 0,
  alert_30 INTEGER NOT NULL DEFAULT 1,
  alert_15 INTEGER NOT NULL DEFAULT 1,
  alert_release INTEGER NOT NULL DEFAULT 1,
  daily_briefing INTEGER NOT NULL DEFAULT 1,
  briefing_time TEXT NOT NULL DEFAULT '07:30',
  currencies TEXT NOT NULL DEFAULT 'USD,EUR,GBP,JPY,CHF,CAD,AUD,NZD'
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One row per logical alert per user. The UNIQUE key is the duplicate guard:
-- the dispatcher claims the row with INSERT OR IGNORE before sending anything.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,               -- t30 | t15 | release | briefing | test
  event_id INTEGER REFERENCES econ_events(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | partial | failed | no_subscription
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,             -- sent | failed | expired
  http_status INTEGER,
  error TEXT,
  attempted_at TEXT NOT NULL,
  UNIQUE (notification_id, subscription_id, attempted_at)
);

CREATE TABLE IF NOT EXISTS app_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; rolls back on throw. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function kvGet(db, key) {
  const r = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(key);
  return r ? r.value : null;
}
export function kvSet(db, key, value) {
  db.prepare('INSERT INTO app_kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
