/**
 * Fastify 5 HTTP + WebSocket server.
 *
 * Every volume change (Main and Zone 2) goes through the guarded VolumeService —
 * there is no raw set-dB route for either channel.
 */

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { z } from 'zod';
import type { NadClient } from './nad/client.js';
import type { BluOSClient } from './bluos/client.js';
import type { VolumeService } from './volume/service.js';
import type { UsageLogger } from './usage/logger.js';
import type { TrackLogger } from './tracks/logger.js';
import type { StateManager } from './state.js';
import type { AppConfig } from './config.js';
import { SETTINGS, applySetting, stepSetting } from './settings.js';
import { isHostAllowed, isOriginAllowed } from './security.js';

interface Deps {
  cfg: AppConfig;
  nad: NadClient;
  bluos: BluOSClient;
  volume: VolumeService;
  usage: UsageLogger;
  tracks: TrackLogger;
  state: StateManager;
}

export async function buildServer(deps: Deps, opts?: { logger?: boolean }) {
  const { cfg, nad, bluos, volume, usage, tracks, state } = deps;
  const app = Fastify({ logger: opts?.logger === false ? false : { level: 'info' } });

  // --- Network hardening (the API controls an amplifier) ---
  // Reject any request whose Host header is not loopback (or a private-LAN host
  // when ALLOW_LAN). This blocks LAN access by default AND defeats DNS-rebinding
  // from arbitrary websites. Paired with binding 127.0.0.1 (see index/standalone).
  const allowLan = cfg.ALLOW_LAN;
  app.addHook('onRequest', async (req, reply) => {
    if (!isHostAllowed(req.headers.host, allowLan)) {
      return reply
        .code(403)
        .send({ ok: false, error: 'forbidden host — loopback only (set ALLOW_LAN=1 to serve the LAN)' });
    }
  });

  // CORS restricted to allowed origins only (the bundled UI is same-origin and
  // sends no Origin; this just refuses cross-site browser calls).
  await app.register(cors, { origin: (origin, cb) => cb(null, isOriginAllowed(origin ?? undefined, allowLan)) });
  await app.register(websocket);

  /** Wrap a synchronous NAD command in a uniform 503-on-failure handler. */
  const cmd = (fn: () => void, reply: import('fastify').FastifyReply) => {
    try {
      fn();
      return { ok: true };
    } catch (e) {
      return reply.code(503).send({ ok: false, error: (e as Error).message });
    }
  };

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/state', async () => state.getState());

  // WebSocket: push current state on connect, then on every change.
  app.get('/ws', { websocket: true }, (socket) => {
    const send = (s: unknown) => {
      try {
        socket.send(JSON.stringify({ type: 'state', payload: s }));
      } catch {
        /* ignore */
      }
    };
    send(state.getState());
    const onState = (s: unknown) => send(s);
    state.on('state', onState);
    socket.on('close', () => state.off('state', onState));
  });

  // ---------- Main zone ----------
  app.post('/api/power', async (req, reply) => {
    const b = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'on:boolean required' });
    return cmd(() => nad.setPower(b.data.on), reply);
  });

  app.post('/api/mute', async (req, reply) => {
    const b = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'on:boolean required' });
    return cmd(() => nad.setMute(b.data.on), reply);
  });

  app.post('/api/source', async (req, reply) => {
    const b = z.object({ index: z.number().int().min(1).max(12) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'index:1-12 required' });
    return cmd(() => nad.setSource(b.data.index), reply);
  });

  app.post('/api/source-names', async (req, reply) => {
    const b = z.object({ names: z.record(z.string(), z.string()) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'names:{idx:name} required' });
    for (const [k, v] of Object.entries(b.data.names)) {
      const idx = Number(k);
      if (Number.isInteger(idx) && idx >= 1 && idx <= 12) state.setSourceNameOverride(idx, v);
    }
    return { ok: true, sourceNames: state.getState().sourceNames };
  });

  app.post('/api/listening-mode', async (req, reply) => {
    const b = z.object({ mode: z.string().min(1) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'mode:string required' });
    return cmd(() => nad.setListeningMode(b.data.mode), reply);
  });

  app.post('/api/dimmer', async (req, reply) => {
    const b = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'on:boolean required' });
    return cmd(() => nad.setDimmer(b.data.on), reply);
  });

  app.post('/api/sleep', async (req, reply) => {
    const b = z.object({ minutes: z.number().int().min(0).max(240) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'minutes:0-240 required' });
    return cmd(() => nad.setSleep(b.data.minutes), reply);
  });

  // ---------- Volume (guarded) — Main ----------
  app.post('/api/volume/step', async (req, reply) => {
    const b = z.object({ deltaDb: z.number() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'deltaDb:number required' });
    const r = volume.step(b.data.deltaDb, 'main');
    if (r.note) state.setNotice(r.note);
    return r.ok ? r : reply.code(409).send(r);
  });

  app.post('/api/volume/set', async (req, reply) => {
    const b = z.object({ targetDb: z.number() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'targetDb:number required' });
    const r = volume.setAbsolute(b.data.targetDb, 'main');
    if (r.note) state.setNotice(r.note);
    return r.ok ? r : reply.code(409).send(r);
  });

  // ---------- Zone 2 ----------
  app.post('/api/zone2/power', async (req, reply) => {
    const b = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'on:boolean required' });
    return cmd(() => nad.setZone2Power(b.data.on), reply);
  });

  app.post('/api/zone2/source', async (req, reply) => {
    const b = z.object({ index: z.number().int().min(1).max(12) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'index:1-12 required' });
    return cmd(() => nad.setZone2Source(b.data.index), reply);
  });

  app.post('/api/zone2/mute', async (req, reply) => {
    const b = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'on:boolean required' });
    return cmd(() => nad.setZone2Mute(b.data.on), reply);
  });

  // Zone 2 volume is guarded by the SAME cap/step as Main.
  app.post('/api/zone2/volume/step', async (req, reply) => {
    const b = z.object({ deltaDb: z.number() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'deltaDb:number required' });
    const r = volume.step(b.data.deltaDb, 'zone2');
    if (r.note) state.setNotice(r.note);
    return r.ok ? r : reply.code(409).send(r);
  });

  app.post('/api/zone2/volume/set', async (req, reply) => {
    const b = z.object({ targetDb: z.number() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'targetDb:number required' });
    const r = volume.setAbsolute(b.data.targetDb, 'zone2');
    if (r.note) state.setNotice(r.note);
    return r.ok ? r : reply.code(409).send(r);
  });

  // ---------- Tuner (responds only when the tuner is the active source) ----------
  app.post('/api/tuner/band', async (req, reply) => {
    const b = z.object({ band: z.enum(['FM', 'AM']) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'band:FM|AM required' });
    return cmd(() => nad.setTunerBand(b.data.band), reply);
  });

  app.post('/api/tuner/preset', async (req, reply) => {
    const b = z.object({ n: z.number().int().min(1).max(40) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'n:1-40 required' });
    return cmd(() => nad.setTunerFmPreset(b.data.n), reply);
  });

  app.post('/api/tuner/mute', async (req, reply) => {
    const b = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'on:boolean required' });
    return cmd(() => nad.setTunerMute(b.data.on), reply);
  });

  app.post('/api/tuner/tune', async (req, reply) => {
    const b = z.object({ dir: z.enum(['up', 'down']) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'dir:up|down required' });
    return cmd(() => nad.tuneFm(b.data.dir), reply);
  });

  // ---------- Generic device settings (allowlisted; NEVER volume) ----------
  app.get('/api/settings/catalog', async () => ({ settings: SETTINGS }));

  app.post('/api/setting', async (req, reply) => {
    const b = z
      .object({ key: z.string(), value: z.union([z.string(), z.boolean(), z.number()]) })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'key + value required' });
    const r = applySetting(nad, b.data.key, b.data.value as string | boolean);
    return r.ok ? r : reply.code(r.error?.startsWith('refused') ? 403 : 409).send(r);
  });

  app.post('/api/setting/step', async (req, reply) => {
    const b = z.object({ key: z.string(), delta: z.number() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'key + delta required' });
    const r = stepSetting(nad, b.data.key, b.data.delta);
    return r.ok ? r : reply.code(r.error?.startsWith('refused') ? 403 : 409).send(r);
  });

  // ---------- Usage log (source + time + volume, from polling) ----------
  app.get('/api/usage', async (req) => {
    const q = req.query as { limit?: string };
    const limit = q.limit ? Math.max(1, Math.min(1000, Number(q.limit) || 200)) : 200;
    return usage.getLog(limit);
  });

  app.post('/api/usage/clear', async () => {
    await usage.clear();
    return { ok: true };
  });

  // ---------- Captured track list (metadata only — your "shopping list") ----------
  app.get('/api/tracks', async (req) => {
    const q = req.query as { limit?: string };
    const limit = q.limit ? Math.max(1, Math.min(5000, Number(q.limit) || 1000)) : 1000;
    return { tracks: tracks.list(limit) };
  });

  app.get('/api/tracks/export.csv', async (_req, reply) => {
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="nad-tracklist.csv"');
    return tracks.toCsv();
  });

  app.post('/api/tracks/clear', async () => {
    await tracks.clear();
    return { ok: true };
  });

  // ---------- BluOS browse / queue / play (same control the BluOS app uses) ----------
  app.get('/api/bluos/browse', async (req) => {
    const q = req.query as { key?: string };
    return bluos.browse(q.key);
  });

  app.get('/api/bluos/queue', async () => ({ queue: await bluos.getQueue() }));

  app.post('/api/bluos/play-url', async (req, reply) => {
    const b = z.object({ url: z.string().min(1) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'url required' });
    try {
      await bluos.playUrl(b.data.url);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, error: 'BluOS unreachable' });
    }
  });

  // ---------- BluOS reboot (only works while the API is responsive) ----------
  app.post('/api/bluos/reboot', async () => {
    return bluos.reboot();
  });

  // ---------- BluOS auto-switch + manual activate ----------
  app.post('/api/autoswitch', async (req, reply) => {
    const b = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'on:boolean required' });
    state.setAutoSwitch(b.data.on);
    return { ok: true, autoSwitchOnPlay: b.data.on };
  });

  // Manually route the receiver to BluOS (power on + select source). No volume change.
  app.post('/api/bluos/activate', async () => {
    return state.activateBluos('manual');
  });

  // ---------- BluOS presets + transport ----------
  app.get('/api/bluos/presets', async () => ({ presets: await bluos.getPresets() }));

  app.post('/api/bluos/preset', async (req, reply) => {
    const b = z.object({ id: z.number().int() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'id:int required' });
    try {
      await bluos.loadPreset(b.data.id);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, error: 'BluOS unreachable' });
    }
  });

  app.post('/api/bluos/transport', async (req, reply) => {
    const b = z.object({ action: z.enum(['play', 'pause', 'skip', 'back']) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'action required' });
    try {
      await bluos[b.data.action]();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, error: 'BluOS unreachable' });
    }
  });

  return app;
}
