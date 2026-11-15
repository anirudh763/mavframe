import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, startServer, openPage, waitParsed, axeViolations, cspViolations } from './browser.mjs';

let browser, server, base;
before(async () => {
  ({ server, base } = await startServer());
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
});
after(async () => { await browser?.close(); server?.close(); });
const open = opts => openPage(browser, base, opts);

test('capture report downloads contain full real C results in JSON, CSV and Markdown', async () => {
  const page = await open();
  for (const [format, label] of [['json', 'JSON'], ['csv', 'CSV'], ['md', 'Markdown']]) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: `Capture report (${label})`, exact: true }).click();
    const artifact = await download;
    const text = await fs.readFile(await artifact.path(), 'utf8');
    assert.match(artifact.suggestedFilename(), new RegExp(`report\\.${format}$`));
    if (format === 'json') {
      const report = JSON.parse(text);
      assert.equal(report.summary.valid_frames, 1497);
      assert.equal(report.summary.crc_failures, 3);
      assert.equal(report.source.sha256, '810d99ac09d8bbe8a13f8bcbd1991126e9fa8bbad5262502fe08c1b7c84ea86d');
      assert.equal(report.sequence_timeline.length, 4);
      assert.equal(text.includes('payload_hex'), false);
    } else assert.match(text, /1497/);
  }
  assert.deepEqual(page.errors, []); await page.close();
});

test('pending finding export rejects a changed capture and retries with the current identity', async () => {
  const page = await open({ hash: '#/frames/0' });
  const downloads = [];
  page.on('download', item => downloads.push(item));
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let pause = true;
    crypto.subtle.digest = (...args) => {
      if (!pause) return digest(...args);
      pause = false;
      return new Promise((resolve, reject) => {
        window.releaseFindingDigest = () => digest(...args).then(resolve, reject);
      });
    };
  });
  await page.locator('#export-finding').click();
  await page.waitForFunction(() => typeof window.releaseFindingDigest === 'function');
  await page.locator('.nav a[data-route="capture"]').click();
  const sample = await fs.readFile(new URL('../../docs/sample/sample-flight.tlog', import.meta.url));
  await page.locator('#file').setInputFiles({ name: 'replacement.bin', mimeType: 'application/octet-stream', buffer: sample.subarray(8, 29) });
  await waitParsed(page, 'replacement.bin');
  await page.locator('.nav a[data-route="frames"]').click();
  await page.locator('#frame-table tbody a').first().click();
  await page.evaluate(() => window.releaseFindingDigest());
  await page.waitForFunction(() => /Could not export|Exported/.test(document.querySelector('#export-status').textContent));
  assert.equal(downloads.length, 0, 'The old finding must not download under a new capture identity.');
  assert.match(await page.locator('#export-status').textContent(), /capture changed/i);
  const pending = page.waitForEvent('download');
  await page.locator('#export-finding').click();
  const item = await pending;
  const finding = JSON.parse(await fs.readFile(await item.path(), 'utf8'));
  assert.equal(finding.file.name, 'replacement.bin');
  assert.equal(finding.finding.offset, 0);
  assert.equal(item.suggestedFilename(), 'mavframe-finding-replacement-offset-0.json');
  assert.deepEqual(page.errors, []); await page.close();
});

test('byte mutation rechecks an actual copy, reports a new CRC failure, and restores the original', async () => {
  const page = await open({ hash: '#/frames/0?tab=bytes' });
  await page.getByRole('button', { name: 'Mutate a copy', exact: true }).click();
  await page.getByLabel('Byte offset', { exact: true }).fill('18');
  await page.getByRole('button', { name: 'Flip bit and check copy', exact: true }).click();
  await waitParsed(page, 'sample-flight.tlog (modified copy)');
  assert.match(await page.locator('#mutation-status').textContent(), /Original retained/);
  await page.getByRole('button', { name: 'Close byte editor', exact: true }).click();
  await page.goto(base + '#/capture');
  assert.match(await page.locator('#m-crc').textContent(), /^4/);
  await page.goto(base + '#/frames/0?tab=bytes');
  await page.getByRole('button', { name: 'Mutate a copy', exact: true }).click();
  await page.getByRole('button', { name: 'Restore original capture', exact: true }).click();
  await waitParsed(page, 'sample-flight.tlog');
  await page.getByRole('button', { name: 'Close byte editor', exact: true }).click();
  await page.goto(base + '#/capture');
  assert.match(await page.locator('#m-crc').textContent(), /^3/);
  assert.deepEqual(page.errors, []); await page.close();
});

test('seeded fuzz calls use a real Wasm worker, preserve capture, and can be cancelled', async () => {
  const page = await open();
  await page.locator('#screen-capture').getByText('Fuzz', { exact: true }).click();
  await page.getByRole('button', { name: 'Run 1,000 fuzz iterations', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#fuzz-status').textContent.startsWith('1000 actual C/Wasm calls'));
  assert.match(await page.locator('#m-frames').textContent(), /^1,497/);
  await page.evaluate(() => { document.querySelector('#run-fuzz').click(); document.querySelector('#cancel-fuzz').click(); });
  await page.waitForFunction(() => document.querySelector('#fuzz-status').textContent.includes('cancelled'));
  assert.deepEqual(page.errors, []); assert.deepEqual(await cspViolations(page), []);
  await page.close();
});

test('Web Serial API test double feeds actual C/Wasm across chunks and releases its port', async () => {
  const page = await open({ route: p => p.addInitScript(() => {
    const serial = new EventTarget();
    window.__serialCounts = { chooser: 0, opened: 0, cancelled: 0, closed: 0 };
    const port = {
      async open(options) {
        window.__serialCounts.opened++; window.__serialCounts.baud = options.baudRate;
        this.readable = new ReadableStream({ start(controller) { window.__serialInput = controller; }, cancel() { window.__serialCounts.cancelled++; } });
      },
      async close() { window.__serialCounts.closed++; this.readable = null; },
    };
    serial.requestPort = async () => { window.__serialCounts.chooser++; return port; };
    Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
  }) });
  await page.locator('#live-panel > summary').click();
  await page.getByRole('button', { name: 'Connect radio', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#live-status').textContent.startsWith('Connected.'));
  await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('sample/sample-flight.tlog')).arrayBuffer()).slice(8, 29);
    for (const value of bytes) window.__serialInput.enqueue(Uint8Array.of(value));
  });
  await page.waitForFunction(() => document.querySelector('#live-frames').textContent === '1');
  await page.evaluate(() => window.__serialInput.close());
  await page.waitForFunction(() => window.__serialCounts.closed === 1);
  assert.equal(await page.locator('#inspect-live').isEnabled(), true, 'a normal stream end preserves its tail for inspection');
  await page.getByRole('button', { name: 'Stop and inspect retained bytes', exact: true }).click();
  await waitParsed(page, 'live-tail.raw');
  assert.match(await page.locator('#source').textContent(), /Retained tail: 21 of 21/);
  assert.deepEqual(await page.evaluate(() => window.__serialCounts), { chooser: 1, opened: 1, cancelled: 0, closed: 1, baud: 115200 });
  await page.getByRole('button', { name: 'Connect radio', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#live-status').textContent.startsWith('Connected.'));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.waitForFunction(() => window.__serialCounts.closed === 2);
  assert.equal(await page.getByRole('button', { name: 'Connect radio', exact: true }).isEnabled(), true);
  assert.deepEqual(page.errors, []); assert.deepEqual(await cspViolations(page), []);
  await page.close();
});

test('expanded capture tools reflow and pass axe at 320, 768 and 1440 in both themes', async () => {
  const out = process.env.MAVFRAME_UPGRADE_EVIDENCE || '/tmp/mavframe-upgrade-browser';
  await fs.mkdir(out, { recursive: true });
  for (const width of [320, 768, 1440]) {
    const page = await open({ viewport: { width, height: 1000 } });
    await page.locator('#live-panel > summary').click();
    await page.locator('#screen-capture').getByText('Fuzz', { exact: true }).click();
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') {
        const hidden = !await page.locator('#theme-toggle').isVisible();
        if (hidden) await page.locator('#menu-btn').click();
        await page.locator('#theme-toggle').click();
        if (hidden) await page.locator('#sheet-close').click();
      }
      assert.deepEqual((await axeViolations(page)).violations, [], `${width}/${theme}`);
      const size = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
      assert.ok(size.page <= size.viewport + 1, JSON.stringify(size));
      await page.screenshot({ path: path.join(out, `mavframe-tools-${width}-${theme}.png`), fullPage: true });
    }
    assert.deepEqual(page.errors, []); await page.close();
  }
});

test('cached inspector reloads offline and still runs the native mutation', async () => {
  const page = await open({ serviceWorkers: 'allow' });
  await page.waitForFunction(() => document.querySelector('#offline-status').textContent.startsWith('Offline inspector ready'));
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.goto(base + '#/capture');
  await page.context().setOffline(true);
  await page.reload(); await waitParsed(page, 'sample-flight.tlog');
  await page.goto(base + '#/frames/0?tab=bytes');
  await page.getByRole('button', { name: 'Mutate a copy', exact: true }).click();
  await page.getByLabel('Byte offset', { exact: true }).fill('18');
  await page.getByRole('button', { name: 'Flip bit and check copy', exact: true }).click();
  await waitParsed(page, 'sample-flight.tlog (modified copy)');
  await page.getByRole('button', { name: 'Close byte editor', exact: true }).click();
  await page.goto(base + '#/capture');
  assert.match(await page.locator('#m-crc').textContent(), /^4/);
  assert.deepEqual(page.errors, []); assert.deepEqual(await cspViolations(page), []);
  await page.context().setOffline(false); await page.close();
});

test('support options keep MIT rights clear and the native dialog traps and returns focus', async () => {
  for (const width of [320, 768, 1440]) {
    const page = await open({ hash: '#/help', viewport: { width, height: 1000 } });
    await page.getByRole('button', { name: 'Support options', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Support options' });
    assert.match(await dialog.textContent(), /no paid commercial licence required/);
    assert.match(await dialog.textContent(), /No payment or email capture/);
    const url = new URL(await page.locator('#team-request').getAttribute('href'));
    assert.equal(url.origin, 'https://github.com');
    assert.equal(url.pathname, '/anirudh763/mavframe/issues/new');
    await page.locator('#close-team-options').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.locator('#team-request').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement === document.querySelector('#open-team-options'));
    await page.locator('#open-team-options').click();
    await page.evaluate(() => { location.hash = '#/capture'; });
    await page.waitForFunction(() => !document.querySelector('#screen-capture').hidden);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement === document.querySelector('#h-capture'));
    assert.deepEqual(page.errors, []); await page.close();
  }
});
