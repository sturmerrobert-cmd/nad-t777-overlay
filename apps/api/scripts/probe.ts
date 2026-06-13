/**
 * Phase 0 discovery probe for the NAD T 777 V3 overlay.
 *
 * Read-only. Sends only `?` query commands to NAD (never `=`/`+`/`-`), and GETs to
 * streaming module / Dirac. Does NOT change any device state. No volume is ever set here.
 *
 * Usage:
 *   DEVICE_IP=192.168.1.50 pnpm probe
 *   pnpm probe -- 192.168.1.50
 *
 * Reports, per interface: live? | sample response | (for NAD: current volume dB).
 */

import net from 'node:net';

const DEVICE_IP = process.argv[2] ?? process.env.DEVICE_IP ?? '';

const NAD_PORT = 23;
const STREAM_PORT = 11000;
const DIRAC_PORT = 5006;
const TIMEOUT_MS = 4000;

if (!DEVICE_IP) {
  console.error(
    'ERROR: DEVICE_IP is required.\n' +
      '  DEVICE_IP=192.168.1.50 pnpm probe   (or)   pnpm probe -- 192.168.1.50\n' +
      'Use the explicit LAN IP of the receiver, not an mDNS/.local name.',
  );
  process.exit(1);
}

type ProbeResult = {
  iface: string;
  live: boolean;
  sample: string;
  extra?: string;
};

/** Open a TCP socket, send NAD `?` queries, collect `Main.*=...` replies. */
function probeNad(ip: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const queries = ['Main.Model?', 'Main.Power?', 'Main.Version?', 'Main.Volume?'];
    const replies: string[] = [];
    let buffer = '';
    let settled = false;

    const socket = net.createConnection({ host: ip, port: NAD_PORT });
    socket.setEncoding('utf8');

    const finish = (live: boolean, note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const volLine = replies.find((l) => l.startsWith('Main.Volume='));
      const volume = volLine ? volLine.slice('Main.Volume='.length).trim() : undefined;
      resolve({
        iface: `NAD control (TCP:${NAD_PORT})`,
        live,
        sample: note ?? (replies.length ? replies.join(' | ') : '(connected, no reply)'),
        extra: volume !== undefined ? `current volume: ${volume} dB` : undefined,
      });
    };

    const timer = setTimeout(() => finish(replies.length > 0, replies.length ? undefined : 'TIMEOUT (no reply within ' + TIMEOUT_MS + 'ms)'), TIMEOUT_MS);

    socket.on('connect', () => {
      // NAD V2.x protocol: ASCII commands terminated by CR.
      socket.write(queries.map((q) => q + '\r').join(''));
    });

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split(/\r\n|\r|\n/);
      buffer = parts.pop() ?? '';
      for (const p of parts) {
        const line = p.trim();
        if (line) replies.push(line);
      }
      // Once we've seen all four answers, finish early.
      if (queries.every((q) => replies.some((r) => r.startsWith(q.replace('?', '='))))) {
        finish(true);
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      finish(false, `ERROR: ${err.code ?? err.message}`);
    });
  });
}

/** GET a URL with a timeout; return status + a short body sample. */
async function httpGet(url: string): Promise<{ ok: boolean; sample: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    const oneLine = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    return { ok: res.ok, sample: `HTTP ${res.status}: ${oneLine || '(empty body)'}` };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const code = e.cause?.code ?? e.name ?? e.message;
    return { ok: false, sample: code === 'AbortError' || e.name === 'AbortError' ? `TIMEOUT (>${TIMEOUT_MS}ms)` : `ERROR: ${code}` };
  } finally {
    clearTimeout(timer);
  }
}

async function probeStream(ip: string): Promise<ProbeResult> {
  const sync = await httpGet(`http://${ip}:${STREAM_PORT}/SyncStatus`);
  const status = sync.ok ? undefined : await httpGet(`http://${ip}:${STREAM_PORT}/Status`);
  const result = sync.ok ? sync : (status ?? sync);
  return {
    iface: `streaming module (HTTP:${STREAM_PORT})`,
    live: result.ok,
    sample: result.sample,
  };
}

async function probeDirac(ip: string): Promise<ProbeResult> {
  const slots = await httpGet(`http://${ip}:${DIRAC_PORT}/api/list-slots`);
  const active = await httpGet(`http://${ip}:${DIRAC_PORT}/api/active-slot`);
  const live = slots.ok || active.ok;
  return {
    iface: `Dirac (HTTP:${DIRAC_PORT})`,
    live,
    sample: `list-slots -> ${slots.sample} || active-slot -> ${active.sample}`,
    extra: live ? 'port 5006 ANSWERS' : 'port 5006 did NOT answer (Dirac features stay gated off)',
  };
}

function printTable(rows: ProbeResult[]): void {
  console.log('\n=== NAD T 777 V3 — Phase 0 discovery ===');
  console.log(`Device: ${DEVICE_IP}\n`);
  for (const r of rows) {
    console.log(`• ${r.iface}`);
    console.log(`    live?   ${r.live ? 'YES' : 'no'}`);
    console.log(`    sample: ${r.sample}`);
    if (r.extra) console.log(`    note:   ${r.extra}`);
    console.log('');
  }
  const nad = rows.find((r) => r.iface.startsWith('NAD'));
  if (nad?.extra?.startsWith('current volume')) {
    console.log(`>> NAD ${nad.extra}  (needed to set MAX_VOLUME_DB)\n`);
  } else {
    console.log('>> NAD current volume: NOT read (TCP:23 unreachable or silent)\n');
  }
}

async function main(): Promise<void> {
  console.log(`Probing ${DEVICE_IP} (read-only; timeout ${TIMEOUT_MS}ms per interface)...`);
  const [nad, stream, dirac] = await Promise.all([
    probeNad(DEVICE_IP),
    probeStream(DEVICE_IP),
    probeDirac(DEVICE_IP),
  ]);
  printTable([nad, stream, dirac]);

  if (!nad.live && !stream.live && !dirac.live) {
    console.log('All three timed out. WSL2 networking checklist:');
    console.log('  1. Confirm the device IP and that it is powered/networked (not in standby-deep-sleep).');
    console.log('  2. From Windows PowerShell, sanity-check:  curl http://' + DEVICE_IP + ':11000/SyncStatus');
    console.log('  3. Consider WSL2 mirrored networking: add [wsl2]\\nnetworkingMode=mirrored to %USERPROFILE%\\.wslconfig, then `wsl --shutdown`.');
    console.log('  4. Always use the explicit IP, never an mDNS/.local name.');
  }
}

main().catch((err) => {
  console.error('Probe crashed:', err);
  process.exit(1);
});
