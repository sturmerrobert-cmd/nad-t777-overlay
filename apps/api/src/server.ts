/**
 * Fastify 5 HTTP + WebSocket server.
 *
 * - GET  /api/health, /api/state
 * - WS   /ws                          → pushes AppState on every change
 * - POST /api/power            {on}
 * - POST /api/volume/step      {deltaDb}     (guarded)
 * - POST /api/volume/set       {targetDb}    (guarded; rejects >MAX_STEP_DB jumps)
 * - POST /api/mute             {on}
 * - POST /api/source           {index 1-12}
 * - POST /api/listening-mode   {mode}
 * - POST /api/bluos/preset     {id}
 * - POST /api/bluos/transport  {action: play|pause|skip|back}
 * - POST /api/source-names     {names}        (UI-editable labels)
 *
 * Every volume change goes through VolumeService — there is no raw set-dB route.
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
import { DEFAULT_SOURCE_NAMES } from './types.js';

interface Deps {
  cfg: AppConfig;
  nad: NadClient;
  bluos: BluOSClient;
  volume: VolumeService;
  state: StateManager;
}

export async function buildServer(deps: Deps) {
  const { cfg, nad, bluos, volume, state } = deps;
  const app = Fastify({ logger: { level: 'info' } });

  await app.register(cors, { origin: true });
  await app.register(websocket);

  // In-memory editable source names (Phase 1; not persisted).
  const sourceNames: Record<number, string> = { ...DEFAULT_SOURCE_NAMES };

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/state', async () => ({ ...state.getState(), sourceNames }));

  // WebSocket: push current state on connect, then on every change.
  app.get('/ws', { websocket: true }, (socket) => {
    const send = (s: unknown) => {
      try {
        socket.send(JSON.stringify({ type: 'state', payload: { ...(s as object), sourceNames } }));
      } catch {
        /* ignore */
      }
    };
    send(state.getState());
    const onState = (s: unknown) => send(s);
    state.on('state', onState);
    socket.on('close', () => state.off('state', onState));
  });

  // --- Power ---
  app.post('/api/power', async (req, reply) => {
    const body = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'on:boolean required' });
    try {
      nad.setPower(body.data.on);
      return { ok: true };
    } catch (e) {
      return reply.code(503).send({ ok: false, error: (e as Error).message });
    }
  });

  // --- Volume (guarded) ---
  app.post('/api/volume/step', async (req, reply) => {
    const body = z.object({ deltaDb: z.number() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'deltaDb:number required' });
    const result = volume.step(body.data.deltaDb);
    if (result.note) state.setNotice(result.note);
    if (!result.ok) return reply.code(409).send(result);
    return result;
  });

  app.post('/api/volume/set', async (req, reply) => {
    const body = z.object({ targetDb: z.number() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'targetDb:number required' });
    const result = volume.setAbsolute(body.data.targetDb);
    if (result.note) state.setNotice(result.note);
    if (!result.ok) return reply.code(409).send(result);
    return result;
  });

  // --- Mute ---
  app.post('/api/mute', async (req, reply) => {
    const body = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'on:boolean required' });
    try {
      nad.setMute(body.data.on);
      return { ok: true };
    } catch (e) {
      return reply.code(503).send({ ok: false, error: (e as Error).message });
    }
  });

  // --- Source ---
  app.post('/api/source', async (req, reply) => {
    const body = z.object({ index: z.number().int().min(1).max(12) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'index:1-12 required' });
    try {
      nad.setSource(body.data.index);
      return { ok: true };
    } catch (e) {
      return reply.code(503).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/api/source-names', async (req, reply) => {
    const body = z
      .object({ names: z.record(z.string(), z.string()) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'names:{idx:name} required' });
    for (const [k, v] of Object.entries(body.data.names)) {
      const idx = Number(k);
      if (Number.isInteger(idx) && idx >= 1 && idx <= 12) sourceNames[idx] = v;
    }
    return { ok: true, sourceNames };
  });

  // --- Listening mode ---
  app.post('/api/listening-mode', async (req, reply) => {
    const body = z.object({ mode: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'mode:string required' });
    try {
      nad.setListeningMode(body.data.mode);
      return { ok: true };
    } catch (e) {
      return reply.code(503).send({ ok: false, error: (e as Error).message });
    }
  });

  // --- BluOS presets + transport ---
  app.get('/api/bluos/presets', async () => ({ presets: await bluos.getPresets() }));

  app.post('/api/bluos/preset', async (req, reply) => {
    const body = z.object({ id: z.number().int() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'id:int required' });
    await bluos.loadPreset(body.data.id);
    return { ok: true };
  });

  app.post('/api/bluos/transport', async (req, reply) => {
    const body = z
      .object({ action: z.enum(['play', 'pause', 'skip', 'back']) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'action required' });
    await bluos[body.data.action]();
    return { ok: true };
  });

  return app;
}
