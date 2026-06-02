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
import type { StateManager } from './state.js';
import type { AppConfig } from './config.js';

interface Deps {
  cfg: AppConfig;
  nad: NadClient;
  bluos: BluOSClient;
  volume: VolumeService;
  state: StateManager;
}

export async function buildServer(deps: Deps) {
  const { nad, bluos, volume, state } = deps;
  const app = Fastify({ logger: { level: 'info' } });

  await app.register(cors, { origin: true });
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

  // ---------- BluOS presets + transport ----------
  app.get('/api/bluos/presets', async () => ({ presets: await bluos.getPresets() }));

  app.post('/api/bluos/preset', async (req, reply) => {
    const b = z.object({ id: z.number().int() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'id:int required' });
    await bluos.loadPreset(b.data.id);
    return { ok: true };
  });

  app.post('/api/bluos/transport', async (req, reply) => {
    const b = z.object({ action: z.enum(['play', 'pause', 'skip', 'back']) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'action required' });
    await bluos[b.data.action]();
    return { ok: true };
  });

  return app;
}
