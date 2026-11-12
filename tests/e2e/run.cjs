// Browser end-to-end acceptance run against the real built app and real provider.
// Usage: npm run build && npm run test:e2e   (needs Playwright Chromium)
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'tradeos-e2e-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`  ✔ ${name}`); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log(`  ✘ ${name}\n    ${e.message.split('\n').slice(0, 6).join('\n    ')}`); }
};

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradeos-e2e-'));
  const server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, NODE_USE_ENV_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 50 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 200));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
  // Instrument permission requests so we can prove none happen on page load.
  await ctx.addInitScript(() => {
    window.__permRequests = 0;
    if (window.Notification) {
      const orig = Notification.requestPermission.bind(Notification);
      Notification.requestPermission = (...a) => { window.__permRequests++; return orig(...a); };
    }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const email = `e2e${Date.now()}@example.com`;

  await step('user can create an account (UI)', async () => {
    await page.goto(`${BASE}/register`);
    await page.getByLabel('Name').fill('Yassine');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('a-strong-password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('heading', { name: 'Hello, Yassine' }).waitFor();
  });

  await step('notification permission is NOT requested on page load', async () => {
    for (const p of ['/', '/calendar', '/settings', '/planner']) { await page.goto(BASE + p); await page.waitForLoadState('networkidle'); }
    assert.equal(await page.evaluate(() => window.__permRequests), 0);
    assert.notEqual(await page.evaluate(() => Notification.permission), 'granted'); // headless Chromium reports 'denied' by default
  });

  await step('user can log out and log in again (UI)', async () => {
    await page.goto(BASE + '/');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Incorrect email or password').waitFor();
    await page.getByLabel('Password').fill('a-strong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Hello, Yassine' }).waitFor();
  });

  await step('user can create and edit a daily plan (UI, persisted)', async () => {
    await page.goto(BASE + '/planner');
    await page.getByLabel('Market bias').fill('USD bid ahead of PPI; fade EURUSD rallies');
    await page.getByLabel('Max trades today').fill('3');
    await page.getByRole('button', { name: 'Create plan' }).click();
    await page.getByText('Plan saved').waitFor();
    await page.reload();
    assert.equal(await page.getByLabel('Market bias').inputValue(), 'USD bid ahead of PPI; fade EURUSD rallies');
    await page.getByLabel('Market bias').fill('Neutral until US PPI');
    await page.getByRole('button', { name: 'Save plan' }).click();
    await page.getByText('Plan saved').first().waitFor();
    await page.reload();
    assert.equal(await page.getByLabel('Market bias').inputValue(), 'Neutral until US PPI');
    await page.getByRole('tab', { name: /Checklist/ }).click();
    await page.locator('label.check').first().click();
    await page.getByRole('tab', { name: /Checklist 1\// }).waitFor();
    await page.screenshot({ path: path.join(SHOTS, 'planner.png') });
  });

  await step('user can register a trade (UI) and dashboard uses the stored record', async () => {
    await page.goto(BASE + '/journal/new');
    await page.getByLabel('Symbol').fill('EURUSD');
    await page.getByLabel('Volume (lots)').fill('0.5');
    await page.getByLabel('Open price').fill('1.0810');
    await page.getByLabel('Stop loss').fill('1.0790');
    await page.getByLabel('Close time').fill('2026-11-10T10:30');
    await page.getByLabel('Open time').fill('2026-11-10T09:15');
    await page.getByLabel('Close price').fill('1.0850');
    await page.getByLabel(/^Profit/).fill('200');
    await page.getByLabel('Commission').fill('-3.5');
    await page.getByLabel('Taken according to plan?').selectOption('1');
    await page.getByLabel('Notes').fill('Clean retest of London low.');
    await page.getByRole('button', { name: 'Save trade' }).click();
    await page.getByText('Trade saved').waitFor();
    await page.goto(BASE + '/');
    await page.getByText('+$196.50').first().waitFor();
    const dash = await page.evaluate(() => fetch('/api/dashboard?mode=demo').then((r) => r.json()));
    assert.equal(dash.stats.trades, 1);
    assert.equal(dash.stats.netPnl, 196.5);
  });

  await step('MT5 CSV can be imported and validated (UI)', async () => {
    const csv = [
      'Time,Position,Symbol,Type,Volume,Price,S / L,T / P,Time,Price,Commission,Swap,Profit',
      '2026.11.09 10:15:02,7001,GBPUSD,sell,0.30,1.27500,1.27800,1.27000,2026.11.09 12:40:10,1.27200,-2.10,0.00,90.00',
      '2026.11.09 15:00:00,7002,XAUUSD,buy,0.10,2650.10,2645.00,2665.00,2026.11.09 16:10:00,2646.00,-1.00,0.00,-41.00',
      '2026.11.09 15:00:00,7003,XAUUSD,buy,zero,2650.10,,,2026.11.09 16:10:00,2646.00,0,0,-41.00',
    ].join('\n');
    const f = path.join(dataDir, 'mt5-history.csv');
    fs.writeFileSync(f, csv);
    await page.goto(BASE + '/import');
    await page.locator('input[type=file]').setInputFiles(f);
    await page.getByText('3. Review & confirm').waitFor();
    await page.getByText(/volume .*not a number/).waitFor();
    await page.screenshot({ path: path.join(SHOTS, 'import.png') });
    await page.getByRole('button', { name: /Import 2 trades/ }).click();
    await page.getByText(/Imported 2 trades/).waitFor();
    await page.locator('input[type=file]').setInputFiles(f);
    await page.getByRole('button', { name: /Import 0 trades/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Import 0 trades/ }).isDisabled(), true, 're-import blocked as duplicate');
  });

  await step('MT5 auto-sync: key created in Settings, EA push appears in the journal', async () => {
    await page.goto(BASE + '/settings#mt5-sync');
    await page.getByRole('button', { name: 'Connect MT5' }).click();
    const key = await page.getByLabel('Sync key').inputValue();
    assert.match(key, /^tos_/);
    const ea = await fetch(`${BASE}/api/mt5/positions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ account: { login: '5550001', server: 'Demo-Server', company: 'Test Broker', currency: 'USD', trade_mode: 'demo', balance: 10039, server_gmt_offset_sec: 7200 },
        positions: [{ ticket: '88001', symbol: 'USDJPY', type: 'sell', volume: 0.2, open_time: Date.parse('2026-11-10T08:00:00Z') / 1000 + 7200, close_time: Date.parse('2026-11-10T09:00:00Z') / 1000 + 7200, open_price: 154.2, close_price: 153.9, sl: 154.6, tp: 0, commission: -1.4, swap: 0, profit: 39.0 }] }),
    }).then((r) => r.json());
    assert.equal(ea.imported, 1);
    await page.reload();
    await page.getByText('Test Broker 5550001').first().waitFor();
    await page.goto(BASE + '/journal');
    await page.getByText('MT5 sync').first().waitFor();
    const dl = await fetch(`${BASE}/downloads/TradeOS_Sync.mq5`).then((r) => r.text());
    assert.match(dl, /api\/mt5\/positions/);
  });

  await step('Demo and Live records remain separate (UI mode switch)', async () => {
    await page.goto(BASE + '/');
    await page.getByRole('group', { name: 'Account mode' }).getByRole('button', { name: 'Live' }).click();
    await page.getByText(/Showing LIVE accounts only/).waitFor();
    await page.getByText(/No closed live trades yet/).waitFor();
    const live = await page.evaluate(() => fetch('/api/trades?mode=live').then((r) => r.json()));
    assert.equal(live.trades.length, 0);
    await page.getByRole('group', { name: 'Account mode' }).getByRole('button', { name: 'Demo' }).click();
    await page.getByText(/Showing DEMO accounts only/).waitFor();
    const demo = await page.evaluate(() => fetch('/api/trades?mode=demo').then((r) => r.json()));
    assert.equal(demo.trades.length, 4);
    await page.screenshot({ path: path.join(SHOTS, 'dashboard.png'), fullPage: true });
  });

  await step('economic news is retrieved from the real provider and shown in Casablanca time', async () => {
    let st;
    for (let i = 0; i < 40; i++) {
      st = await page.evaluate(() => fetch('/api/calendar/status').then((r) => r.json()));
      if (st.lastAttemptAt) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(st.hasData, `provider sync failed: ${st.lastError}`);
    await page.goto(BASE + '/calendar');
    await page.getByText('Forex Factory (faireconomy.media weekly feed)').waitFor();
    await page.getByText('Last successful update:').waitFor();
    const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(new Date()));
    const api = await page.evaluate((d) => fetch(`/api/calendar?from=${d}&to=${d}&impacts=high,medium,low,holiday`).then((r) => r.json()), today);
    const wk = await page.evaluate(() => fetch('/api/calendar?impacts=high,medium,low,holiday').then((r) => r.json()));
    const all = [...api.events, ...wk.events];
    assert.ok(all.length > 0, 'events present');
    for (const e of all) {
      const expect = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Casablanca', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(e.scheduledAtUtc));
      if (!e.allDay) assert.equal(e.localTime, expect);
    }
    await page.screenshot({ path: path.join(SHOTS, 'calendar.png'), fullPage: false });
  });

  await step('High and Medium impact filters work (UI)', async () => {
    await page.goto(BASE + '/calendar');
    const w0 = page.waitForResponse((r) => r.url().includes('/api/calendar?'));
    await page.getByRole('button', { name: 'Week' }).click();
    await w0; await page.waitForTimeout(150);
    assert.ok(await page.locator('.event').count() > 0, 'week has events');
    const badges = async () => page.locator('.event .badge').filter({ hasText: /^(High|Medium|Low|Holiday)$/ }).allTextContents();
    let b = await badges();
    assert.ok(b.every((x) => x === 'High' || x === 'Medium'), `default filters: ${[...new Set(b)]}`);
    const calResp = () => page.waitForResponse((r) => r.url().includes('/api/calendar?'));
    let w = calResp();
    await page.getByRole('button', { name: 'Medium', pressed: true }).click();
    await w; await page.waitForTimeout(150);
    b = await badges();
    assert.ok(b.every((x) => x === 'High'), `high only: ${[...new Set(b)]}`);
    w = calResp();
    await page.getByRole('button', { name: 'High', pressed: true }).click();
    await w;
    w = calResp();
    await page.getByRole('button', { name: 'Medium', pressed: false }).click();
    await w; await page.waitForTimeout(150);
    b = await badges();
    assert.ok(b.every((x) => x === 'Medium'), `medium only: ${[...new Set(b)]}`);
    await page.getByRole('button', { name: 'High', pressed: false }).click();
  });

  await step('Web Push: Enable button requests permission only on click; subscription stored or graceful error', async () => {
    await ctx.grantPermissions(['notifications'], { origin: BASE });
    await page.goto(BASE + '/settings');
    await page.waitForLoadState('networkidle');
    assert.equal(await page.evaluate(() => window.__permRequests), 0);
    const btn = page.getByRole('button', { name: 'Enable Notifications' });
    await btn.waitFor();
    await btn.click();
    await page.waitForFunction(() => window.__permRequests === 1);
    // Either the browser's push service accepted the subscription, or it failed and we show a clear message.
    const outcome = await Promise.race([
      page.getByText('Receiving notifications').waitFor({ timeout: 20000 }).then(() => 'subscribed'),
      page.locator('.alert.error').waitFor({ timeout: 20000 }).then(() => 'error'),
    ]);
    const subs = await page.evaluate(() => fetch('/api/push/subscriptions').then((r) => r.json()));
    if (outcome === 'subscribed') {
      assert.equal(subs.subscriptions.length, 1);
      console.log('    (browser push service accepted subscription)');
    } else {
      const msg = await page.locator('.alert.error').textContent();
      console.log(`    (no push service reachable from this sandbox — shown to user: "${msg.trim()}")`);
      assert.match(msg, /push subscription|push service/i);
      assert.equal(subs.subscriptions.length, 0);
    }
    globalThis.__pushOutcome = outcome;
    await page.screenshot({ path: path.join(SHOTS, 'settings.png'), fullPage: true });
  });

  await step('users can disable notifications (UI master switch persists)', async () => {
    await page.goto(BASE + '/settings');
    const sw = page.getByLabel('All news notifications');
    assert.equal(await sw.isChecked(), true);
    const swBox = page.locator('label.switch', { has: sw });
    await swBox.scrollIntoViewIfNeeded();
    await swBox.click();
    await page.waitForResponse((r) => r.url().includes('/api/notifications/prefs') && r.request().method() === 'PUT');
    const p = await page.evaluate(() => fetch('/api/notifications/prefs').then((r) => r.json()));
    assert.equal(p.prefs.enabled, false);
    await swBox.click();
    await page.waitForResponse((r) => r.url().includes('/api/notifications/prefs') && r.request().method() === 'PUT');
  });

  await step('unsupported browsers are handled gracefully (no PushManager)', async () => {
    const c2 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await c2.addInitScript(() => { delete window.PushManager; });
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/login`);
    await p2.getByLabel('Email').fill(email);
    await p2.getByLabel('Password').fill('a-strong-password');
    await p2.getByRole('button', { name: 'Sign in' }).click();
    await p2.getByRole('heading', { name: 'Hello, Yassine' }).waitFor();
    await p2.goto(`${BASE}/settings`);
    await p2.getByText(/Web Push isn't available here/).waitFor();
    assert.equal(await p2.getByRole('button', { name: 'Enable Notifications' }).count(), 0);
    await c2.close();
  });

  await step('another user cannot see this user\'s trades (separate browser session)', async () => {
    const c3 = await browser.newContext();
    const p3 = await c3.newPage();
    await p3.goto(`${BASE}/register`);
    await p3.getByLabel('Email').fill(`other${Date.now()}@example.com`);
    await p3.getByLabel('Password').fill('another-password');
    await p3.getByRole('button', { name: 'Create account' }).click();
    await p3.getByRole('heading', { name: /Hello/ }).waitFor();
    const mine = await page.evaluate(() => fetch('/api/trades?mode=demo').then((r) => r.json()));
    const id = mine.trades[0].id;
    const r = await p3.evaluate((tid) => fetch(`/api/trades/${tid}`).then((x) => x.status), id);
    assert.equal(r, 404);
    const theirs = await p3.evaluate(() => fetch('/api/trades?mode=demo').then((x) => x.json()));
    assert.equal(theirs.trades.length, 0);
    await c3.close();
  });

  await step('responsive: mobile layout renders with bottom navigation', async () => {
    const m = await browser.newContext({ ...require('playwright').devices['iPhone 13'], storageState: await ctx.storageState() });
    const mp = await m.newPage();
    await mp.goto(BASE + '/');
    // A subscribed iPhone (long user-agent) must not widen the Settings page.
    const ec = require('node:crypto').createECDH('prime256v1'); ec.generateKeys();
    const sub = { endpoint: 'https://web.push.apple.com/QE2e-test-' + Date.now(), keys: { p256dh: ec.getPublicKey().toString('base64url'), auth: require('node:crypto').randomBytes(16).toString('base64url') } };
    const st = await mp.evaluate((s) => fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TradeOS-Request': '1' }, body: JSON.stringify({ subscription: s }) }).then((r) => r.status), sub);
    assert.equal(st, 201);
    await mp.locator('.mobile-nav').waitFor();
    assert.equal(await mp.locator('.sidebar').isVisible(), false);
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow, false, 'no horizontal scroll');
    await mp.screenshot({ path: path.join(SHOTS, 'mobile-dashboard.png') });
    for (const pth of ['/calendar', '/journal', '/journal/new', '/import', '/planner', '/discipline', '/reports', '/settings', '/weekly']) {
      await mp.goto(BASE + pth);
      await mp.waitForLoadState('networkidle');
      const w = await mp.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      assert.ok(w[0] <= w[1] + 1, `${pth} overflows horizontally: ${w[0]}px > ${w[1]}px`);
    }
    await mp.goto(BASE + '/settings');
    await mp.getByText('iPhone · Safari').waitFor();
    await mp.screenshot({ path: path.join(SHOTS, 'mobile-settings.png'), fullPage: true });
    await mp.goto(BASE + '/calendar');
    await mp.waitForLoadState('networkidle');
    await mp.screenshot({ path: path.join(SHOTS, 'mobile-calendar.png') });
    await m.close();
  });

  await step('Quick trade on a phone: taps only, profit calculated, saved to the journal', async () => {
    const m = await browser.newContext({ ...require('playwright').devices['iPhone 13'], storageState: await ctx.storageState() });
    const mp = await m.newPage();
    mp.on('pageerror', (e) => errors.push(e.message));
    await mp.goto(BASE + '/');
    await mp.getByRole('link', { name: 'New trade' }).click();
    await mp.getByRole('heading', { name: 'Quick trade' }).waitFor();
    await mp.getByRole('group', { name: 'Direction' }).getByRole('button', { name: 'Sell' }).click();
    await mp.getByRole('button', { name: 'GBPUSD', exact: true }).click();
    await mp.getByRole('button', { name: '0.5', exact: true }).click();
    await mp.getByLabel('Entry price').fill('1.2750');
    await mp.getByLabel('Exit price').fill('1.2720');
    assert.equal(await mp.getByLabel(/^Profit/).inputValue(), '150', 'profit calculated: 30 pips × 0.5 lot');
    await mp.getByText('Calculated · 100 000 units per lot').waitFor();
    await mp.getByRole('button', { name: '1h', exact: true }).click();
    await mp.getByRole('button', { name: 'Yes', exact: true }).click();
    assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'no horizontal scroll');
    await mp.screenshot({ path: path.join(SHOTS, 'mobile-quick.png') });
    await mp.getByRole('button', { name: /^Save GBPUSD/ }).click();
    await mp.getByText('GBPUSD SELL saved').waitFor();
    await mp.screenshot({ path: path.join(SHOTS, 'mobile-quick-saved.png') });
    const t = (await mp.evaluate(() => fetch('/api/trades?mode=demo').then((r) => r.json()))).trades.find((x) => x.symbol === 'GBPUSD' && x.profit === 150);
    assert.ok(t, 'trade stored');
    assert.equal(Date.parse(t.closeTime) - Date.parse(t.openTime), 3600e3, 'held 1h');
    assert.equal(t.planFollowed, true);
    assert.equal(t.direction, 'sell');
    await mp.getByRole('button', { name: 'Add another' }).click();
    await mp.getByLabel('Entry price').waitFor();
    assert.equal(await mp.getByLabel('Entry price').inputValue(), '');
    await m.close();
  });

  await step('PWA: manifest and service worker served', async () => {
    const man = await page.evaluate(() => fetch('/manifest.webmanifest').then((r) => r.json()));
    assert.equal(man.display, 'standalone');
    assert.ok(man.icons.some((i) => i.sizes === '512x512'));
    const sw = await page.evaluate(() => navigator.serviceWorker.getRegistration('/').then((r) => !!r));
    assert.equal(sw, true);
  });

  await step('no uncaught page errors', async () => { assert.deepEqual(errors, []); });

  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser acceptance steps passed. Screenshots: ${SHOTS}`);
  if (failed.length) { console.log('\nServer log tail:\n' + log.split('\n').slice(-15).join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
