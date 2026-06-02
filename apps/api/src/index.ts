/**
 * Entry point. Loads + validates config (refuses to start without MAX_VOLUME_DB),
 * wires the NAD/BluOS clients, the guarded volume service, the state manager, and
 * the HTTP/WS server. On startup it READS and displays current volume; it never
 * sets it (G2). If the observed volume is over the cap it raises a UI alert (and
 * only pulls down if CLAMP_ON_OBSERVED is enabled).
 */

import { loadConfig } from './config.js';
import { NadClient } from './nad/client.js';
import { BluOSClient } from './bluos/client.js';
import { VolumeService } from './volume/service.js';
import { UsageLogger } from './usage/logger.js';
import { TrackLogger } from './tracks/logger.js';
import { StateManager } from './state.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error('\n' + (err as Error).message + '\n');
    process.exit(1);
  }

  const log = (level: 'info' | 'warn', msg: string) =>
    level === 'warn' ? console.warn(`[volume] ${msg}`) : console.log(`[volume] ${msg}`);

  const nad = new NadClient({ host: cfg.DEVICE_IP, port: cfg.NAD_PORT });
  const bluos = new BluOSClient({ host: cfg.DEVICE_IP, port: cfg.BLUOS_PORT });
  const volume = new VolumeService(nad, cfg, log);
  const usage = new UsageLogger(cfg.USAGE_LOG_FILE, log);
  const tracks = new TrackLogger(cfg.TRACKS_LOG_FILE, log);
  const state = new StateManager(nad, bluos, volume, usage, tracks, cfg, log);

  nad.on('connect', () => console.log(`[nad] connected ${cfg.DEVICE_IP}:${cfg.NAD_PORT}`));
  nad.on('disconnect', () => console.warn('[nad] disconnected'));
  nad.on('error', (e: Error & { code?: string }) =>
    console.warn(`[nad] socket error: ${e.code ?? e.message}`),
  );

  nad.start();
  state.start();

  const app = await buildServer({ cfg, nad, bluos, volume, usage, tracks, state });
  await app.listen({ host: '0.0.0.0', port: cfg.HTTP_PORT });

  console.log(`\nNAD overlay API listening on http://0.0.0.0:${cfg.HTTP_PORT}`);
  console.log(`  device:        ${cfg.DEVICE_IP}  (NAD:${cfg.NAD_PORT}, BluOS:${cfg.BLUOS_PORT})`);
  console.log(`  MAX_VOLUME_DB: ${cfg.maxVolumeDb} dB  (hard cap)`);
  console.log(`  ZONE2 cap:     ${cfg.zone2MaxVolumeDb} dB${cfg.ZONE2_MAX_VOLUME_DB === undefined ? ' (fallback to Main)' : ''}`);
  console.log(`  MAX_STEP_DB:   ${cfg.maxStepDb} dB`);
  console.log(`  WARN_VOLUME_DB:${cfg.WARN_VOLUME_DB ?? '(unset)'}  DEFAULT(UI):${cfg.DEFAULT_VOLUME_DB ?? '(unset)'}`);
  console.log(`  CLAMP_ON_OBSERVED:${cfg.CLAMP_ON_OBSERVED}  VOLUME_WATCHDOG:${cfg.VOLUME_WATCHDOG}`);
  console.log(`  Dirac (5006):  absent (Phase 0) — panel disabled\n`);

  const shutdown = () => {
    console.log('\nshutting down...');
    state.stop();
    nad.stop();
    app.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
