import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, startServer, axeViolations, smallTargets } from './browser.mjs';

let server, base, browser;
const out = process.env.MAVFRAME_EVIDENCE_DIR ? new URL(process.env.MAVFRAME_EVIDENCE_DIR + '/', 'file:///') : new URL('../../../artifacts/verification/product-repair-20261116/mavframe/', import.meta.url);
before(async () => {
  if (process.env.MAVFRAME_BASE_URL) base = process.env.MAVFRAME_BASE_URL.replace(/\/?$/, '/');
  else ({ server, base } = await startServer());
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  await fs.mkdir(out, { recursive: true });
});
after(async () => { await browser?.close(); server?.close(); });
const done = page => page.waitForFunction(() => document.querySelector('#scenario-status').textContent.startsWith('Demo complete') && !document.querySelector('#run-scenario').disabled);
const run = async (page, id) => {
  await page.locator('#scenario-select').selectOption(id);
  await page.locator('#run-scenario').click();
  await done(page);
};

test('first-load preview, all actual scenarios, checksum details, reset and keyboard retry', async () => {
  const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + 'workbench');
  assert.match(await page.locator('#scenario-preview').innerText(), /Two heartbeats/);
  assert.equal(await page.locator('#scenario-result').isVisible(), false);
  await page.locator('#run-scenario').focus(); await page.keyboard.press('Enter'); await done(page);
  assert.match(await page.locator('#scenario-telemetry').innerText(), /Quadrotor[\s\S]*Standby[\s\S]*Armed[\s\S]*No/);
  assert.match(await page.locator('#scenario-validation').innerText(), /2 CRC-valid frames; 0 CRC failures/);
  await run(page, 'gps'); assert.match(await page.locator('#scenario-findings').innerText(), /1112 m in 1.0 s/);
  await run(page, 'altitude-control'); assert.match(await page.locator('#scenario-findings').innerText(), /100.0 m in 2.0 s/);
  assert.match(await page.locator('#scenario-findings').innerText(), /requested altitude 110 m \(MAV_FRAME_GLOBAL_RELATIVE_ALT\)/);
  await page.screenshot({ path: new URL('altitude-control-1440.png', out).pathname, fullPage: true });
  await run(page, 'crc');
  assert.match(await page.locator('#scenario-validation').innerText(), /0 CRC-valid frames; 1 CRC failures/);
  assert.match(await page.locator('#scenario-telemetry').innerText(), /No accepted telemetry/);
  await page.locator('#scenario-result details').last().locator('summary').click();
  await page.locator('#scenario-inspect').click();
  await page.waitForFunction(() => document.title.startsWith('Hex / binary comparison'));
  assert.match(await page.locator('#crc-compare').innerText(), /Mismatch: CRC failed/);
  assert.match(page.url(), /scenario=crc/);
  await page.screenshot({ path: new URL('crc-failure-1440.png', out).pathname, fullPage: true });
  await page.locator('#reset-scenario').click();
  assert.equal(await page.locator('#scenario-result').isVisible(), false);
  assert.equal(await page.locator('#reset-scenario').isDisabled(), true);
  assert.equal(await page.locator('#run-scenario').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter'); await done(page);
  assert.match(await page.locator('#scenario-validation').innerText(), /2 CRC-valid frames/);
  assert.deepEqual(errors, []); await page.close();
});

test('scenario URLs, copied filters, direct refresh and Back/Forward survive three independent tabs', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  const pages = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  await Promise.all(pages.map((page, index) => page.goto(base + ['?scenario=heartbeat', 'anomalies?scenario=gps&check=all&msg=24', 'stream?scenario=altitude-control&row=1&tab=decoded'][index])));
  await Promise.all(pages.map(done));
  assert.match(await pages[1].locator('#scenario-findings').innerText(), /1112 m/);
  assert.match(await pages[2].locator('#scenario-findings').innerText(), /100.0 m in 2.0 s/);
  const urls = pages.map(page => page.url());
  await run(pages[0], 'crc');
  assert.equal(pages[1].url(), urls[1]); assert.equal(pages[2].url(), urls[2]);
  assert.equal(await pages[1].locator('#msg-filter').inputValue(), '24');
  await pages[0].goBack(); await done(pages[0]);
  assert.match(await pages[0].locator('#scenario-validation').innerText(), /2 CRC-valid frames; 0 CRC failures/);
  await pages[0].goForward(); await done(pages[0]);
  assert.match(await pages[0].locator('#scenario-validation').innerText(), /0 CRC-valid frames; 1 CRC failures/);
  await pages[1].reload(); await done(pages[1]);
  assert.equal(await pages[1].locator('#msg-filter').inputValue(), '24');
  await pages[1].getByRole('button', { name: 'Valid CRC', exact: true }).click();
  assert.match(pages[1].url(), /scenario=gps/);
  const copied = await context.newPage(); await copied.goto(pages[1].url()); await done(copied);
  assert.equal(await copied.locator('#msg-filter').inputValue(), '24');
  assert.equal(await copied.locator('#frame-table tbody tr').count(), 2);
  for (const page of pages) await page.reload();
  await Promise.all(pages.map(done));
  assert.match(await pages[0].locator('#scenario-validation').innerText(), /1 CRC failures/);
  assert.match(await pages[1].locator('#scenario-findings').innerText(), /1112 m/);
  assert.match(await pages[2].locator('#scenario-findings').innerText(), /100.0 m in 2.0 s/);
  await context.close();
});

test('unknown sample, controlled download failure and invalid file recover without losing a successful result', async () => {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  await page.goto(base + '?scenario=unknown');
  assert.match(await page.locator('#scenario-status').innerText(), /Unknown scenario/);
  await run(page, 'heartbeat');
  await page.route('**/sample/scenario-gps.tlog', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.locator('#scenario-select').selectOption('gps'); await page.locator('#run-scenario').click();
  await page.waitForFunction(() => document.querySelector('#scenario-status').textContent.startsWith('Could not run'));
  assert.match(await page.locator('#scenario-status').innerText(), /HTTP 503.*Retry/);
  assert.match(await page.locator('#scenario-validation').innerText(), /2 CRC-valid frames/);
  await page.unroute('**/sample/scenario-gps.tlog'); await run(page, 'gps');
  await page.locator('#file').setInputFiles({ name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) });
  assert.match(await page.locator('#status').innerText(), /empty \(0 bytes\)/);
  assert.match(await page.locator('#scenario-findings').innerText(), /1112 m/);
  const capture = await fs.readFile(new URL('../../docs/sample/scenario-heartbeat.tlog', import.meta.url));
  await page.locator('#file').setInputFiles({ name: 'user-copy.tlog', mimeType: 'application/octet-stream', buffer: capture });
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'user-copy.tlog loaded.');
  assert.equal(new URL(page.url()).searchParams.has('scenario'), false);
  assert.equal(await page.locator('#reset-scenario').isDisabled(), true);
  assert.match(await page.locator('#scenario-source').innerText(), /^user-copy.tlog$/);
  assert.match(await page.locator('#scenario-validation').innerText(), /2 CRC-valid frames/);
  await page.close();
});

test('verified offline assets reopen scenario URLs and still run the actual parser', async () => {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  await page.goto(base + '?scenario=heartbeat'); await done(page);
  await page.waitForFunction(() => document.querySelector('#offline-status').textContent.startsWith('Offline assets verified on this device'));
  await context.setOffline(true);
  await page.goto(base + 'anomalies?scenario=gps&check=all'); await done(page);
  assert.match(await page.locator('#scenario-findings').innerText(), /1112 m in 1.0 s/);
  await page.goto(base + 'stream?scenario=crc&row=0&check=crc'); await done(page);
  assert.match(await page.locator('#scenario-validation').innerText(), /0 CRC-valid frames; 1 CRC failures/);
  assert.match(await page.locator('#crc-compare').innerText(), /Mismatch: CRC failed/);
  await context.setOffline(false);
  await context.close();
});

test('unavailable parser gives an actionable scenario error on a direct anomaly route', async () => {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  await page.route('**/mavframe.wasm', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto(base + 'anomalies?scenario=heartbeat');
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Could not load the parser'));
  assert.match(await page.locator('#scenario-status').innerText(), /parser.*could not load.*Reconnect and reload/i);
  assert.equal(await page.locator('#run-scenario').isDisabled(), true);
  await page.unroute('**/mavframe.wasm'); await page.reload(); await done(page);
  assert.match(await page.locator('#scenario-validation').innerText(), /2 CRC-valid frames/);
  await page.close();
});

for (const width of [320, 375, 768, 1024, 1440]) test(`scenario results reflow and pass axe in both themes at ${width}px`, async () => {
  const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '?scenario=altitude-control'); await done(page);
  page.setDefaultTimeout(10000);
  for (const dark of [false, true]) {
    if (dark) { if (width < 1000) await page.locator('#menu-btn').click(); await page.locator('#theme-toggle').click(); if (width < 1000) await page.keyboard.press('Escape'); await page.reload(); await done(page); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark'); }
    assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(await smallTargets(page), []);
    assert.deepEqual((await axeViolations(page)).violations, []);
    await page.screenshot({ path: new URL(`scenario-${width}-${dark ? 'dark' : 'light'}.png`, out).pathname, fullPage: true });
  }
  assert.deepEqual(errors, []); await page.close();
});
