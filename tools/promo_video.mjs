// A promo clip (docs/promo): a race against the bots, in Ukrainian, in the bunch at the foot of the first climb,
// with a few camera views. Needs `npm start` on :8000 and a real GPU (headed Chrome). Writes a .webm to
// .local/promo/raw and prints the second the clip starts; cut it with ffmpeg, e.g. for 32 s from START + 3:
//   ffmpeg -ss <START+3> -to <START+35> -i raw/x.webm -c:v libx264 -pix_fmt yuv420p -crf 23 -an -movflags +faststart out.mp4
// Usage: node tools/promo_video.mjs [routeId] [WxH], e.g. carpathians 1280x720 or carpathians 720x1280
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = new URL('../.local/promo/raw/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const [W, H] = (process.argv[3] || '1280x720').split('x').map(Number);
const ROUTE = process.argv[2] || 'carpathians';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch({ headless: false, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: W, height: H }, locale: 'uk-UA', recordVideo: { dir: OUT, size: { width: W, height: H } } });
await ctx.route(/goatcounter|gc\.zgo\.at/, (r) => r.abort());
const p = await ctx.newPage();
const t0 = Date.now();
await p.addInitScript((route) => {
  localStorage.setItem('gruppetto.welcomed', 'guest'); localStorage.setItem('powerup-seen-drawer', '1');
  const s = JSON.parse(localStorage.getItem('powerup.settings') || '{}');
  Object.assign(s, { mode: 'race', routeId: route, bots: 8, name: 'Сергій', ftp: 250, weight: 72, ftpSet: true, sound: false, voice: false, soundOnByDefault: true });
  localStorage.setItem('powerup.settings', JSON.stringify(s));
}, ROUTE);
await p.goto('http://localhost:8000/?debug');
await p.waitForFunction(() => document.getElementById('btn-start')?.onclick);
await p.evaluate(() => { const s = document.getElementById('sim'); if (!s.checked) s.click(); });
await p.click('#btn-start');
await sleep(500);
if (await p.isVisible('#preflight')) await p.click('#preflight-go');
await p.waitForFunction(() => window.__ride && window.__ride.elapsed > 2, null, { timeout: 120000, polling: 500 });
await p.addStyleTag({ content: '#toast { display: none !important; }' }); // no camera captions in the clip
// into the bunch at the foot of the first climb: you and the bots side by side, as a race looks mid-way
await p.evaluate(() => {
  const R = window.__ride, c = R.route.climbs[0], at = (c ? c.start : 2000) - 250;
  R.dist = R.prevDist = at;
  R.bots.forEach((b, i) => { b.dist = at + 6 + (i % 5) * 7 - Math.floor(i / 5) * 4; if ('prevDist' in b) b.prevDist = b.dist; });
  const s = document.getElementById('sim-power'); s.value = 300; s.oninput?.();
});
await sleep(12000); // the world around the new place builds, the riders settle
const start = (Date.now() - t0) / 1000;
console.log('START', start.toFixed(1));
await p.mouse.move(W - 2, H / 2);
for (const [key, ms] of (W < H ? [['1', 8000], ['4', 7000], ['5', 7000], ['0', 7000], ['1', 6000]] : [['1', 7000], ['0', 6000], ['9', 6000], ['4', 6000], ['5', 5000], ['1', 5000]])) { await p.keyboard.press(key); await sleep(ms); }
console.log('END', ((Date.now() - t0) / 1000).toFixed(1));
await ctx.close();
await b.close();
