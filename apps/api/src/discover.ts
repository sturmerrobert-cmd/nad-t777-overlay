/**
 * LAN auto-discovery for the NAD receiver.
 *
 * Enumerates the host's own IPv4 /24 subnets and scans each host for a NAD that
 * answers the control handshake on TCP:23 (`Main.Model?` -> `Main.Model=...`).
 * Returns the first match. Used by the standalone (exe) build so the user does
 * not have to configure DEVICE_IP — it just finds the receiver.
 */

import net from 'node:net';
import os from 'node:os';

export interface Discovered {
  ip: string;
  model?: string;
}

/** Distinct "a.b.c" /24 prefixes of this host's non-internal IPv4 interfaces. */
function localSubnets(): string[] {
  const bases = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) {
        const p = a.address.split('.');
        if (p.length === 4) bases.add(p.slice(0, 3).join('.'));
      }
    }
  }
  return [...bases];
}

/** Probe one host: connect to :23, send `Main.Model?`, return the model or null. */
function probeNad(ip: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    const sock = net.createConnection({ host: ip, port: 23 });
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => finish(null));
    sock.on('error', () => finish(null));
    sock.on('connect', () => {
      sock.setEncoding('utf8');
      sock.write('Main.Model?\r');
    });
    sock.on('data', (d: string) => {
      buf += d;
      const m = buf.match(/Main\.Model=(\S+)/);
      if (m?.[1]) finish(m[1]);
    });
  });
}

/**
 * Probe whether a TCP port is open on a host (connect-only, no I/O).
 *
 * Used to detect the Dirac Live control port (:5006), which only the later
 * Dirac-equipped NAD models expose. Resolves true on a successful connect.
 */
export function probeTcpOpen(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const sock = net.createConnection({ host, port });
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
    sock.on('connect', () => finish(true));
  });
}

/**
 * Scan the local subnet(s) for a NAD. Resolves to the first responder, or null.
 * Scans in batches to bound the number of concurrent sockets.
 */
export async function discoverNad(opts?: {
  timeoutMs?: number;
  batchSize?: number;
  onProgress?: (msg: string) => void;
}): Promise<Discovered | null> {
  const timeoutMs = opts?.timeoutMs ?? 500;
  const batchSize = opts?.batchSize ?? 64;
  for (const base of localSubnets()) {
    opts?.onProgress?.(`scanning ${base}.0/24 for the NAD…`);
    const ips = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
    for (let i = 0; i < ips.length; i += batchSize) {
      const batch = ips.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (ip) => ({ ip, model: await probeNad(ip, timeoutMs) })),
      );
      const hit = results.find((r) => r.model);
      if (hit) return { ip: hit.ip, model: hit.model ?? undefined };
    }
  }
  return null;
}
