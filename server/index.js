// Local / VPS entry point: serves the built SPA and runs the scheduler in-process.
import { bootstrap } from './bootstrap.js';
import { startScheduler } from './scheduler.js';

const { app, db, sender } = await bootstrap();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`TradeOS listening on http://${host}:${port}`);
  if (process.env.DISABLE_SCHEDULER !== '1') startScheduler(db, { send: sender });
});
