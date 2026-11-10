# TradeOS

Responsive, PWA-ready trading workspace: journal, MT5 CSV import, daily planner,
economic calendar with Web Push alerts, discipline tracking, and daily/weekly reports.

## Run

```bash
npm install
npm run build
NODE_USE_ENV_PROXY=0 npm start        # http://127.0.0.1:3000
```

Development: `npm run dev:server` and `npx vite` (proxies `/api` to :3000).
Configuration: see `.env.example`. Web Push requires HTTPS in production (localhost is exempt);
set `COOKIE_SECURE=1` and fixed `VAPID_*` keys when deploying.

## Tests

```bash
npm test            # 29 API/unit/integration tests (node:test)
npm run test:e2e    # 16 browser acceptance steps (Playwright Chromium, real provider)
```

## Architecture

| Area | Location |
|---|---|
| HTTP API (every query scoped to the signed-in user) | `server/app.js` |
| Schema (SQLite via `node:sqlite`) | `server/db.js` |
| Auth: scrypt passwords, hashed session tokens, CSRF header, rate limit | `server/auth.js` |
| Timezone (IANA via Intl; never fixed offsets) | `server/lib/time.js` |
| Economic calendar ingest, staleness, backoff, de-duplication | `server/services/calendar.js`, `providers/forexfactory.js` |
| Notification dispatcher (T-30, T-15, release, daily briefing, retries) | `server/services/notifications.js` |
| VAPID + encrypted delivery | `server/services/push.js` |
| Background jobs | `server/scheduler.js` |
| MT5 CSV parser/validator | `server/services/mt5.js` |
| Stats & discipline scoring | `server/services/stats.js` |
| React client, service worker, manifest | `client/` |

**Economic data.** Provider: the Forex Factory weekly JSON feed (`nfs.faireconomy.media`), synced hourly,
honouring `Retry-After`, with exponential backoff. Events are never generated; data older than 6 h is
flagged stale. The feed does not publish actual figures, so past events show *"Time passed · not verified"*.
Providers are pluggable (`server/services/providers/`).

**Duplicate alerts** are prevented in three layers: a `UNIQUE(user_id, dedupe_key)` row claimed before sending,
the push `Topic` header, and the service-worker notification `tag`.

**Extending later** (AI Coach, Backtesting, Telegram): add a provider/channel module beside
`services/push.js` and a dispatcher target in `notifications.js`; trades, plans and reviews are
already exposed through user-scoped APIs.
