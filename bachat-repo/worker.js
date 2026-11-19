/**
 * Unified Cloudflare Worker Entry (for *.workers.dev with Static Assets + Scheduled Cron)
 * - Routes /api/* to the exact same API handler as Cloudflare Pages (functions/api/[[path]].js)
 * - Serves static PWA files from ./public via env.ASSETS
 * - Runs the 2nd Friday 6:00 PM Nepal Time reminder in scheduled()
 */
import { onRequest } from './functions/api/[[path]].js';
import cronWorker from './cron-worker/worker.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
      return onRequest({
        request,
        env,
        waitUntil: ctx && ctx.waitUntil ? ctx.waitUntil.bind(ctx) : () => {}
      });
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Static ASSETS binding not configured', { status: 500 });
  },

  async scheduled(event, env, ctx) {
    return cronWorker.scheduled(event, env, ctx);
  }
};
