/**
 * Build the user-manual PDF from the English UI screenshots + section text.
 * Usage: node tools/make-manual-pdf.mjs <imageDir> <outFile>
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const imgDir = process.argv[2];
const outFile = process.argv[3] ?? 'NAD-T777-Overlay-Manual.pdf';

// file → { title, bullets[] }
const SECTIONS = [
  ['6.png', 'Main', [
    'A re-creation of the NAD front display: source, volume, now-playing, listening mode and the live incoming signal (codec, channels, rate, lock).',
    'Power on/off, mute, and the guarded volume (− / + buttons and a slider that cannot go above your cap).',
    'Source grid uses the names configured in your receiver. Listening mode and a Signal / quality card (codec, channels, sample rate, video, A/V delay).',
    'When you are not on the BluOS source, a “Play on NAD (BluOS)” shortcut appears.',
  ]],
  ['7.png', 'Sound', [
    'Tone: Bass, Treble and Tone defeat (bypass).',
    'Bass management & levels: subwoofer on/off, enhanced bass, center/sub level, center dialog.',
    'Speaker config: Front / Center / Surround set Large or Small; crossover frequencies are shown read-only.',
    'Surround params: Dolby Center Spread / Panorama are settable; the rest (DRC, widths, DTS) are shown read-only.',
    'All controls react instantly and accumulate on rapid clicks; the receiver echoes the value back within ~1.5 s.',
  ]],
  ['8.png', 'Playback', [
    '“Play on NAD now” — one click powers on, switches to BluOS and resumes the stream (e.g. Spotify). Volume is never changed.',
    'Optional auto-switch to BluOS when playback starts. Note: on another source the receiver hides BluOS as “External Source”, so the button is the reliable way.',
    'BluOS module card shows status and how to reboot it (the module has no remote-reboot API — use the BluOS app or a rear-panel power-cycle).',
    'Now-playing with cover art, transport (back/play/pause/skip), BluOS presets and the current play queue.',
  ]],
  ['9.png', 'Library', [
    'Browse BluOS exactly like the BluOS app: Playlists, Radio, Spotify, TIDAL, TuneIn and — when you connect a NAS/USB — your local library. Tap to drill in or play.',
    'My track list captures what you heard (titles / artists only — never audio) and exports to CSV.',
    'A legal “shopping list”: buy the files (Bandcamp / Qobuz / 7digital) or add them to a NAS so BluOS plays them locally.',
  ]],
  ['10.png', 'Tuner', [
    'Band (FM / AM), tuning (◀ / ▶) and FM presets P1–P10.',
    'Tuner controls respond only when the tuner is the active source — use “Switch to Tuner” first.',
  ]],
  ['11.png', 'Zone 2', [
    'Zone 2 power, mute and source (independent of the main zone).',
    'Guarded Zone 2 volume with its OWN cap (separate from Main); the slider cannot exceed it.',
    'Output mode Variable / Fixed. Fixed outputs a set level and is NOT bounded by the Zone 2 cap — use with care.',
  ]],
  ['12.png', 'Usage log', [
    'What played, for how long and how loud — derived purely from polling.',
    'A new segment starts when the source changes or power toggles; each row shows start/end, duration and volume min / avg / max.',
    'History is persisted, so it survives restarts. Clear removes it.',
  ]],
  ['13.png', 'System', [
    'Display dimmer, sleep timer, auto-standby and OSD temperature display.',
    'HDMI-CEC (ARC / audio / switch / power). If the TV “blocks” source switching, turn off CEC switch and/or ARC here.',
    'Device info (model, firmware, triggers, video resolution, A/V delay) and the live volume-safety settings for Main and Zone 2.',
  ]],
  ['14.png', 'Manual (built-in)', [
    'The same guide is available inside the app under the Manual tab, in Polish, English and German.',
    'Switch language any time with the PL / EN / DE buttons in the top-right; your choice is remembered.',
  ]],
];

const PAGE_W = 595.28, PAGE_H = 841.89; // A4 portrait (pt)
const M = 40;

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const fontB = await doc.embedFont(StandardFonts.HelveticaBold);
const accent = rgb(0.29, 0.64, 1);
const ink = rgb(0.1, 0.12, 0.15);
const grey = rgb(0.35, 0.38, 0.42);

// Helvetica (WinAnsi) can't encode some Unicode; map to safe equivalents.
const safe = (s) => String(s)
  .replace(/−/g, '-')   // minus sign
  .replace(/[◀⏮⬅]/g, '<')
  .replace(/[▶⏭➡]/g, '>')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/→/g, '->');

function wrap(text, f, size, maxW) {
  const words = safe(text).split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (f.widthOfTextAtSize(test, size) > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

// Cover
{
  const p = doc.addPage([PAGE_W, PAGE_H]);
  p.drawRectangle({ x: 0, y: PAGE_H - 150, width: PAGE_W, height: 150, color: rgb(0.055, 0.07, 0.09) });
  p.drawText('NAD T 777', { x: M, y: PAGE_H - 80, size: 34, font: fontB, color: rgb(1, 1, 1) });
  p.drawText('Control & Monitoring Overlay', { x: M, y: PAGE_H - 110, size: 16, font, color: accent });
  p.drawText('User Manual', { x: M, y: PAGE_H - 135, size: 13, font, color: rgb(0.8, 0.84, 0.9) });

  let y = PAGE_H - 200;
  const intro = [
    'A small, local-only web overlay to control and monitor a NAD T 777 receiver.',
    'Everything runs on your LAN — no cloud, no third-party login.',
    '',
    'VOLUME SAFETY (most important): the app can NEVER exceed your volume cap and NEVER',
    'raises volume on its own. Main and Zone 2 each have their own cap. A single command',
    'cannot jump more than the step limit, and changes above the warn level ask to confirm.',
    '',
    'This manual walks through every screen. The same guide is built into the app',
    '(Manual tab) in Polish, English and German.',
  ];
  for (const line of intro) {
    p.drawText(safe(line), { x: M, y, size: 11, font: line.startsWith('VOLUME') ? fontB : font, color: line.startsWith('VOLUME') ? ink : grey });
    y -= 18;
  }
  p.drawText('localhost — open in your browser after launch', { x: M, y: 50, size: 9, font, color: grey });
}

// One page per section
let idx = 1;
for (const [file, title, bullets] of SECTIONS) {
  const p = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M;

  p.drawText(safe(`${idx}.  ${title}`), { x: M, y: y - 18, size: 20, font: fontB, color: ink });
  p.drawLine({ start: { x: M, y: y - 26 }, end: { x: PAGE_W - M, y: y - 26 }, thickness: 2, color: accent });
  y -= 44;

  // screenshot scaled to content width
  const png = await doc.embedPng(readFileSync(join(imgDir, file)));
  const maxW = PAGE_W - 2 * M;
  const scale = maxW / png.width;
  const w = maxW, h = png.height * scale;
  p.drawImage(png, { x: M, y: y - h, width: w, height: h });
  p.drawRectangle({ x: M, y: y - h, width: w, height: h, borderColor: rgb(0.8, 0.82, 0.85), borderWidth: 0.5 });
  y -= h + 18;

  for (const b of bullets) {
    const lines = wrap(b, font, 10.5, maxW - 14);
    p.drawText('•', { x: M, y: y - 9, size: 10.5, font: fontB, color: accent });
    for (const line of lines) {
      p.drawText(line, { x: M + 14, y: y - 9, size: 10.5, font, color: ink });
      y -= 15;
    }
    y -= 4;
  }
  p.drawText(`NAD T 777 Overlay — User Manual`, { x: M, y: 28, size: 8, font, color: grey });
  p.drawText(`${idx + 1}`, { x: PAGE_W - M - 10, y: 28, size: 8, font, color: grey });
  idx++;
}

writeFileSync(outFile, await doc.save());
console.log('PDF written:', outFile, `(${SECTIONS.length + 1} pages)`);
