# TradeOS

Responsive, PWA-ready trading workspace: journal, MT5 CSV import, daily planner,
economic calendar with Web Push alerts, discipline tracking, and daily/weekly reports.

## Deploy free: Vercel + Neon + cron-job.org

1. **Vercel** → Add New → Project → import this GitHub repo → Deploy (settings come from `vercel.json`).
2. **Neon database**: in the Vercel project → Storage → Create Database → Neon (free) → connect to the project.
   This adds `DATABASE_URL`. Tables are created automatically on first request.
3. **CRON_SECRET**: Project → Settings → Environment Variables → add `CRON_SECRET` (a long random string) → Redeploy.
4. **cron-job.org** (free): create a job for `https://<your-app>.vercel.app/api/cron/tick`, every 1 minute,
   with header `Authorization: Bearer <CRON_SECRET>`. This drives calendar sync and the 30/15-minute alerts.
5. Open `https://<your-app>.vercel.app/api/health` — `casablancaOffset_2026_11_10` must be `0`
   (Morocco is UTC+0 since 2026-09-20). Then register, go to Settings → Enable Notifications → Send test.

VAPID keys are generated once and stored in the database (or set `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`).
Screenshots are stored in Postgres and resized in the browser (Vercel limits uploads to 4.5 MB).

## Run locally

```bash
npm install
npm run build
npm start        # http://127.0.0.1:3000 — embedded Postgres in ./data, scheduler runs in-process
```

Development: `npm run dev:server` and `npx vite` (proxies `/api` to :3000). See `.env.example`.

## Tests

```bash
npm test            # 30 API/unit/integration tests on embedded Postgres (PGlite)
npm run test:pg     # same tests against a real Postgres server (TEST_DATABASE_URL)
npm run test:e2e    # 16 browser acceptance steps (Playwright Chromium, real provider)
```

## Architecture

| Area | Location |
|---|---|
| HTTP API (every query scoped to the signed-in user) | `server/app.js` |
| Schema (Postgres: Neon in production, PGlite locally) | `server/db.js` |
| Vercel function / shared bootstrap | `api/index.js`, `server/bootstrap.js` |
| Auth: scrypt passwords, hashed session tokens, CSRF header, rate limit | `server/auth.js` |
| Timezone (IANA via Intl; never fixed offsets) | `server/lib/time.js` |
| Economic calendar ingest, staleness, backoff, de-duplication | `server/services/calendar.js`, `providers/forexfactory.js` |
| Notification dispatcher (T-30, T-15, release, daily briefing, retries) | `server/services/notifications.js` |
| VAPID + encrypted delivery | `server/services/push.js` |
| Background jobs (in-process locally; `/api/cron/tick` on Vercel) | `server/scheduler.js` |
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
