/**
 * Standalone entry for the single-file Windows .exe.
 *
 * - No .env required: ships with the user's confirmed safety defaults; an
 *   optional `nad-config.json` next to the exe overrides any of them.
 * - Auto-discovers the NAD on the LAN if DEVICE_IP is not configured, and caches
 *   the result back to nad-config.json.
 * - Serves the built web UI (embedded) + the API from one port, then opens the
 *   browser. NAD/BluOS control behaves exactly as in dev.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { exec } from 'node:child_process';
import { loadConfig } from './config.js';
import { NadClient } from './nad/client.js';
import { BluOSClient } from './bluos/client.js';
import { VolumeService } from './volume/service.js';
import { UsageLogger } from './usage/logger.js';
import { TrackLogger } from './tracks/logger.js';
import { StateManager } from './state.js';
import { buildServer } from './server.js';
import { discoverNad } from './discover.js';
// Generated at build time from apps/web/dist (path -> { type, b64 }).
import { WEB } from './embedded-web.generated.js';

/** Directory the exe lives in (for config + logs), or cwd in dev. */
const appDir = process.execPath.toLowerCase().endsWith('node')
  ? process.cwd()
  : dirname(process.execPath);
const configPath = join(appDir, 'nad-config.json');

interface FileConfig {
  DEVICE_IP?: string;
  MAX_VOLUME_DB?: number;
  MAX_STEP_DB?: number;
  WARN_VOLUME_DB?: number;
  DEFAULT_VOLUME_DB?: number;
  ZONE2_MAX_VOLUME_DB?: number;
  ZONE2_WARN_VOLUME_DB?: number;
  HTTP_PORT?: number;
  AUTOSWITCH_ON_PLAY?: boolean;
}

const DEFAULTS: FileConfig = {
  MAX_VOLUME_DB: -30,
  MAX_STEP_DB: 5,
  WARN_VOLUME_DB: -40,
  DEFAULT_VOLUME_DB: -50,
  ZONE2_MAX_VOLUME_DB: -30,
  ZONE2_WARN_VOLUME_DB: -40,
  HTTP_PORT: 8787,
  AUTOSWITCH_ON_PLAY: false,
};

function readFileConfig(): FileConfig {
  try {
    return existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf8')) as FileConfig) : {};
  } catch {
    return {};
  }
}
function saveFileConfig(cfg: FileConfig): void {
  try {
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function main(): Promise<void> {
  console.log('NAD T 777 overlay — standalone\n');
  const fileCfg = { ...DEFAULTS, ...readFileConfig() };

  // Resolve device IP: configured, else auto-discover on the LAN.
  let deviceIp = fileCfg.DEVICE_IP;
  if (!deviceIp) {
    console.log('No DEVICE_IP configured — scanning the local network for the NAD…');
    const found = await discoverNad({ onProgress: (m) => console.log('  ' + m) });
    if (found) {
      deviceIp = found.ip;
      fileCfg.DEVICE_IP = deviceIp;
      saveFileConfig(fileCfg);
      console.log(`  found ${found.model ?? 'NAD'} at ${deviceIp} (saved to nad-config.json)\n`);
    } else {
      console.error(
        '\nCould not find the NAD on the local network automatically.\n' +
          `Create "${configPath}" with { "DEVICE_IP": "192.168.x.y" } and relaunch.\n`,
      );
      process.exit(1);
    }
  }

  // Feed loadConfig() via env (reuses all validation/safety rules).
  const dataDir = join(appDir, 'data');
  try { mkdirSync(dataDir, { recursive: true }); } catch { /* ignore */ }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVICE_IP: deviceIp,
    MAX_VOLUME_DB: String(fileCfg.MAX_VOLUME_DB),
    MAX_STEP_DB: String(fileCfg.MAX_STEP_DB),
    WARN_VOLUME_DB: String(fileCfg.WARN_VOLUME_DB),
    DEFAULT_VOLUME_DB: String(fileCfg.DEFAULT_VOLUME_DB),
    ZONE2_MAX_VOLUME_DB: String(fileCfg.ZONE2_MAX_VOLUME_DB),
    ZONE2_WARN_VOLUME_DB: String(fileCfg.ZONE2_WARN_VOLUME_DB),
    HTTP_PORT: String(fileCfg.HTTP_PORT),
    AUTOSWITCH_ON_PLAY: String(fileCfg.AUTOSWITCH_ON_PLAY),
    USAGE_LOG_FILE: join(dataDir, 'usage-log.jsonl'),
    TRACKS_LOG_FILE: join(dataDir, 'tracks.jsonl'),
  };

  let cfg;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const log = () => {};
  const nad = new NadClient({ host: cfg.DEVICE_IP, port: cfg.NAD_PORT });
  const bluos = new BluOSClient({ host: cfg.DEVICE_IP, port: cfg.BLUOS_PORT });
  const volume = new VolumeService(nad, cfg, log);
  const usage = new UsageLogger(cfg.USAGE_LOG_FILE, log);
  const tracks = new TrackLogger(cfg.TRACKS_LOG_FILE, log);
  const state = new StateManager(nad, bluos, volume, usage, tracks, cfg, log);

  nad.start();
  state.start();

  const app = await buildServer({ cfg, nad, bluos, volume, usage, tracks, state }, { logger: false });

  // Serve the embedded web UI for any non-API GET (SPA fallback to index.html).
  app.get('/*', async (req, reply) => {
    let p = req.url.split('?')[0] ?? '/';
    while (p.startsWith('/')) p = p.slice(1);
    if (p === '') p = 'index.html';
    const asset = WEB[p] ?? WEB['index.html'];
    if (!asset) return reply.code(404).send('not found');
    reply.header('content-type', asset.type);
    return reply.send(Buffer.from(asset.b64, 'base64'));
  });

  const url = `http://localhost:${cfg.HTTP_PORT}`;
  await app.listen({ host: '0.0.0.0', port: cfg.HTTP_PORT });
  console.log(`\nReady. Open ${url}`);
  console.log(`Device: ${cfg.DEVICE_IP}  ·  Volume cap: ${cfg.maxVolumeDb} dB (Zone 2 ${cfg.zone2MaxVolumeDb} dB)`);
  console.log('Config file: ' + configPath);
  console.log('\n(Leave this window open. Close it to stop the overlay.)\n');
  openBrowser(url);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
