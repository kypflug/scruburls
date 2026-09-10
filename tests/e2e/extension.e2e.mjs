/*
 * End-to-end check: loads the unpacked extension into Chromium (via Playwright),
 * waits for the declarativeNetRequest rules to compile and navigates to a few
 * URLs served by a local HTTP server. Hostnames are mapped to 127.0.0.1 with
 * --host-resolver-rules so the real provider patterns match.
 *
 * Usage (needs `npm install playwright` somewhere on NODE_PATH, and port 80 or
 * root; otherwise a random port is used and the Google redirect case cannot match):
 *   node tests/e2e/extension.e2e.mjs
 * Optional: CHROME_PATH=/path/to/chrome
 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const seen = [];
const server = http.createServer((req, res) => {
  seen.push(req.headers.host + req.url);
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>t</title><h1 id="h">ok ' + req.url + '</h1>');
});
await new Promise((r, j) => { server.once('error', j); server.listen(80, '127.0.0.1', r); }).catch(() => new Promise(r => server.listen(0, '127.0.0.1', r)));
const PORT = server.address().port;
console.log('server port', PORT);
const rules = 'MAP example.test 127.0.0.1, MAP www.google.com 127.0.0.1, MAP www.amazon.com 127.0.0.1, MAP fls-na.amazon.com 127.0.0.1';

const context = await chromium.launchPersistentContext('', {
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--host-resolver-rules=${rules}`, '--no-sandbox'],
});

let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
console.log('service worker:', sw.url());
sw.on('console', m => console.log('  [sw]', m.text()));

// wait until rules compiled
let stats;
for (let i = 0; i < 60; i++) {
  stats = await sw.evaluate(async () => {
    if (typeof chrome === 'undefined' || !chrome.storage) return { notReady: true };
    const s = await chrome.storage.local.get(['dnrStats', 'hashStatus', 'dataHash']);
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return { stats: s.dnrStats ? JSON.parse(s.dnrStats) : null, hashStatus: s.hashStatus, active: rules.length };
  });
  if (stats.stats && stats.active) break;
  if (i % 10 === 9) console.log('  waiting...', JSON.stringify(stats));
  await new Promise(r => setTimeout(r, 500));
}
console.log('DNR:', JSON.stringify(stats));

const results = [];
async function nav(url, expect, label) {
  const page = await context.newPage();
  const before = seen.length;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 15000 }).catch(e => console.log('   goto:', e.message.split('\n')[0]));
    await page.waitForTimeout(1500);
    const finalUrl = page.url();
    const ok = typeof expect === 'function' ? expect(finalUrl) : finalUrl === expect;
    results.push({ label, ok, finalUrl, requests: seen.slice(before) });
    console.log((ok ? 'PASS' : 'FAIL'), label, '\n   final:', finalUrl, '\n   server saw:', JSON.stringify(seen.slice(before)));
  } finally { await page.close(); }
}

await nav(`http://example.test${PORT === 80 ? '' : ':' + PORT}/page?utm_source=a&utm_medium=b&id=5`, `http://example.test${PORT === 80 ? '' : ':' + PORT}/page?id=5`, 'global utm params (DNR)');
await nav(`http://example.test${PORT === 80 ? '' : ':' + PORT}/page?fbclid=abc&gclid=x&a=1`, `http://example.test${PORT === 80 ? '' : ':' + PORT}/page?a=1`, 'fbclid/gclid (DNR)');
await nav(`http://example.test${PORT === 80 ? '' : ':' + PORT}/page?id=5#utm_source=x&sec=2`, `http://example.test${PORT === 80 ? '' : ':' + PORT}/page?id=5#sec=2`, 'fragment (safety net)');
await nav(`http://www.amazon.com${PORT === 80 ? '' : ':' + PORT}/dp/exampleProduct/ref=sxin_0_pb?__mk_de_DE=x&keywords=tea&pd_rd_i=exampleProduct&pd_rd_r=8d39e4cd&pd_rd_w=1pcKM&pd_rd_wg=hYrNl&pf_rd_p=50bbfd25&pf_rd_r=0GMWD0YY&qid=1517757263&rnid=2914120011`, `http://www.amazon.com${PORT === 80 ? '' : ':' + PORT}/dp/exampleProduct`, 'amazon (DNR chain)');
await nav(`http://www.google.com${PORT === 80 ? '' : ':' + PORT}/url?q=http%3A%2F%2Fexample.test${PORT === 80 ? '' : '%3A' + PORT}%2Ftarget%3Fx%3D1%26utm_source%3Dg&sa=D`, `http://example.test${PORT === 80 ? '' : ':' + PORT}/target?x=1`, 'google redirect tracker (SW fallback)');
await nav(`http://fls-na.amazon.com${PORT === 80 ? '' : ':' + PORT}/1/batch/1/OP/x`, (u) => u.includes('siteBlockedAlert.html'), 'domain blocking (block page)');
await nav(`http://example.test${PORT === 80 ? '' : ':' + PORT}/clean?id=5`, `http://example.test${PORT === 80 ? '' : ':' + PORT}/clean?id=5`, 'clean url untouched');
await nav(`http://127.0.0.1${PORT === 80 ? '' : ':' + PORT}/local?utm_source=x`, `http://127.0.0.1${PORT === 80 ? '' : ':' + PORT}/local?utm_source=x`, 'local host skipped');

// history API injection
{
  const page = await context.newPage();
  const H = `http://example.test${PORT === 80 ? '' : ':' + PORT}`;
  await page.goto(`${H}/hist?keep=1`);
  await page.evaluate(() => history.replaceState(null, '', '/hist?keep=1&utm_source=injected'));
  await page.waitForTimeout(1500);
  const ok = page.url() === `${H}/hist?keep=1`;
  console.log((ok ? 'PASS' : 'FAIL'), 'history API cleaning', page.url());
  results.push({ label: 'history', ok });
  await page.close();
}

// sub resource: image with tracking params
{
  const page = await context.newPage();
  const before = seen.length;
  await page.goto(`http://example.test${PORT === 80 ? '' : ':' + PORT}/imgpage`);
  await page.evaluate((port) => new Promise(r => { const i = new Image(); i.onload = i.onerror = r; i.src = `http://example.test${port === 80 ? '' : ':' + port}/img.png?utm_campaign=x&w=1`; }), PORT);
  await page.waitForTimeout(500);
  const reqs = seen.slice(before);
  const ok = reqs.some(r => r.endsWith('/img.png?w=1')) && !reqs.some(r => r.includes('utm_campaign'));
  console.log((ok ? 'PASS' : 'FAIL'), 'sub resource image (DNR)', JSON.stringify(reqs));
  results.push({ label: 'img', ok });
  await page.close();
}

const st = await sw.evaluate(async () => {
  const s = await chrome.storage.local.get(['cleanedCounter', 'totalCounter', 'log', 'loggingStatus']);
  return { cleaned: s.cleanedCounter, total: s.totalCounter, logging: s.loggingStatus };
});
console.log('counters:', JSON.stringify(st));

// popup renders
{
  const page = await context.newPage();
  const extId = new URL(sw.url()).host;
  page.on('pageerror', e => console.log('  [popup error]', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('  [popup console]', m.text()); });
  await page.goto(`chrome-extension://${extId}/html/popup.html`);
  await page.waitForTimeout(800);
  console.log('popup texts:', await page.locator('#configs_head').textContent(), '|', await page.locator('#hashStatus').textContent(), '|', await page.locator('#dnr_status').textContent(), '|', await page.locator('#statistics_value').textContent());
  for (const p of ['settings', 'log', 'cleaningTool', 'siteBlockedAlert']) {
    const pg = await context.newPage();
    pg.on('pageerror', e => console.log(`  [${p} error]`, e.message));
    pg.on('console', m => { if (m.type() === 'error') console.log(`  [${p} console]`, m.text()); });
    await pg.goto(`chrome-extension://${extId}/html/${p}.html`);
    await pg.waitForTimeout(600);
    console.log(p, 'title:', await pg.title());
    if (p === 'cleaningTool') {
      await pg.fill('#dirtyURLs', 'https://example.com/?utm_source=x&a=1\nhttps://www.google.com/url?q=https%3A%2F%2Fexample.org%2F');
      await pg.click('#cleaning_tool_btn'); await pg.waitForTimeout(300);
      console.log('  cleaning tool output:', JSON.stringify(await pg.inputValue('#cleanURLs')));
    }
    if (p === 'settings') console.log('  settings dnr:', (await pg.locator('#dnr_status').textContent()).slice(0, 200));
    await pg.close();
  }
  await page.close();
}

await context.close();
server.close();
const passed = results.filter(r => r.ok).length;
console.log('SUMMARY', passed + '/' + results.length, 'passed');
process.exit(passed === results.length ? 0 : 1);
