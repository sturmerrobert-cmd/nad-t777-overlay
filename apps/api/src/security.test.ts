import { describe, it, expect } from 'vitest';
import { isHostAllowed, isOriginAllowed } from './security.js';

describe('isHostAllowed', () => {
  it('allows loopback regardless of ALLOW_LAN', () => {
    for (const lan of [false, true]) {
      expect(isHostAllowed('localhost', lan)).toBe(true);
      expect(isHostAllowed('localhost:8787', lan)).toBe(true);
      expect(isHostAllowed('127.0.0.1:8787', lan)).toBe(true);
      expect(isHostAllowed('[::1]:8787', lan)).toBe(true);
    }
  });

  it('rejects missing or foreign hosts when LAN is off (DNS-rebinding defense)', () => {
    expect(isHostAllowed(undefined, false)).toBe(false);
    expect(isHostAllowed('attacker.example.com:8787', false)).toBe(false);
    expect(isHostAllowed('evil.local', false)).toBe(false);
    expect(isHostAllowed('192.168.1.50:8787', false)).toBe(false); // LAN blocked by default
  });

  it('accepts private-LAN hosts and *.local only when ALLOW_LAN', () => {
    expect(isHostAllowed('192.168.1.50:8787', true)).toBe(true);
    expect(isHostAllowed('10.0.0.5', true)).toBe(true);
    expect(isHostAllowed('172.16.3.4', true)).toBe(true);
    expect(isHostAllowed('172.32.0.1', true)).toBe(false); // outside 172.16-31
    expect(isHostAllowed('receiverhq.local', true)).toBe(true);
    expect(isHostAllowed('attacker.example.com', true)).toBe(false); // public still blocked
  });
});

describe('isOriginAllowed', () => {
  it('allows missing Origin (same-origin / non-browser)', () => {
    expect(isOriginAllowed(undefined, false)).toBe(true);
  });
  it('allows loopback origins, blocks foreign', () => {
    expect(isOriginAllowed('http://localhost:5173', false)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:8787', false)).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', false)).toBe(false);
    expect(isOriginAllowed('http://192.168.1.50', false)).toBe(false);
    expect(isOriginAllowed('http://192.168.1.50', true)).toBe(true);
  });
  it('rejects malformed origin', () => {
    expect(isOriginAllowed('not a url', false)).toBe(false);
  });
});
