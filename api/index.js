// Vercel serverless entry: every /api/* request is routed here (see vercel.json).
// Static files (the React build in dist/) are served by Vercel's CDN.
import { bootstrap } from '../server/bootstrap.js';

let ready;
export default async function handler(req, res) {
  ready ||= bootstrap({ serveStatic: false }).catch((e) => { ready = null; throw e; });
  const { app } = await ready;
  return app(req, res);
}
