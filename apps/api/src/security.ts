/**
 * Network hardening helpers.
 *
 * The API controls a physical amplifier, so it must not be reachable from the
 * LAN or from any website the user happens to visit. Two defenses, both keyed
 * off the request's Host header:
 *
 *  - Loopback-only by default (paired with binding 127.0.0.1).
 *  - A Host-header allowlist that defeats DNS-rebinding: a malicious page that
 *    rebinds its own hostname to 127.0.0.1 still sends *its* hostname in Host,
 *    which is not in the allowlist — so the request is rejected even though it
 *    reaches loopback.
 *
 * CORS does NOT protect against rebinding (the rebound request is "same-origin"
 * to the attacker page), which is why the Host check is the primary control.
 */

/** Strip port and IPv6 brackets, lowercase. */
function normalizeHost(host: string): string {
  return host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Is this Host header allowed to reach the API?
 * Loopback is always allowed; private-LAN hosts and `*.local` only when
 * `allowLan` is true (explicit opt-in). Missing Host → rejected.
 */
export function isHostAllowed(host: string | undefined, allowLan: boolean): boolean {
  if (!host) return false;
  const h = normalizeHost(host);
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (allowLan && (PRIVATE_V4.test(h) || h.endsWith('.local'))) return true;
  return false;
}

/** CORS origin check: same-origin/non-browser (no Origin) is fine; otherwise the origin's host must be allowed. */
export function isOriginAllowed(origin: string | undefined, allowLan: boolean): boolean {
  if (!origin) return true; // same-origin requests and non-browser clients send no Origin
  try {
    return isHostAllowed(new URL(origin).host, allowLan);
  } catch {
    return false;
  }
}
