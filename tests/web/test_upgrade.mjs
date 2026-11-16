import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium, DOCS, startServer, openPage, waitParsed, axeViolations, cspViolations } from './browser.mjs';

let browser, server, base;
before(async () => {
  ({ server, base } = await startServer());
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
});
after(async () => { await browser?.close(); server?.close(); });
const open = opts => openPage(browser, base, opts);
async function navigatorStatus(page) {
  return page.evaluate(() => new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 3000);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data); };
    navigator.serviceWorker.controller?.postMessage({ type: 'GET_OFFLINE_STATUS' }, [channel.port2]);
  }));
}

test('capture report downloads contain full real C results in JSON, CSV and Markdown', async () => {
  const page = await open();
  for (const [format, label] of [['json', 'JSON'], ['csv', 'CSV'], ['md', 'Markdown']]) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: `Export ${label}`, exact: true }).click();
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

test('selected frame can produce a bounded printable Link Health report without payload fields', async () => {
  const page = await open({ hash: '#/frames/0?tab=bytes', viewport: { width: 1440, height: 900 } });
  await page.evaluate(() => { window.__printCount = 0; window.print = () => { window.__printCount++; }; });
  await page.getByRole('button', { name: 'Print report / Save PDF' }).click();
  await page.waitForFunction(() => window.__printCount === 1 && document.body.classList.contains('print-report-mode'));
  const report = await page.locator('#print-report-page').innerText();
  assert.match(report, /SHA-256 [a-f0-9]{64}/);
  assert.match(report, /Pinned common and ArduPilotMega definitions|Pinned common and ArduPilotMega/);
  assert.match(report, /Selected valid finding at byte/);
  assert.match(report, /Unsupported/); assert.match(report, /Timestamp reversals/); assert.match(report, /Sender IDs/);
  assert.match(report, /CRC is not authentication/);
  assert.equal(await page.locator('#print-report-page input, #print-report-page code[data-payload]').count(), 0);
  const out = process.env.MAVFRAME_UPGRADE_EVIDENCE || '/tmp/mavframe-upgrade-browser';
  await fs.mkdir(out, { recursive: true });
  await page.emulateMedia({ media: 'print' });
  await page.locator('#print-report-page').screenshot({ path: path.join(out, 'mavframe-print-report.png') });
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
  await page.getByRole('button', { name: 'Edit copy', exact: true }).click();
  await page.getByLabel('Byte offset', { exact: true }).fill('18');
  await page.getByRole('button', { name: 'Flip bit', exact: true }).click();
  await waitParsed(page, 'sample-flight.tlog (modified copy)');
  assert.match(await page.locator('#mutation-status').textContent(), /Original retained/);
  await page.getByRole('button', { name: 'Close byte editor', exact: true }).click();
  await page.goto(base + '#/capture');
  assert.match(await page.locator('#m-crc').textContent(), /^4/);
  await page.goto(base + '#/frames/0?tab=bytes');
  await page.getByRole('button', { name: 'Edit copy', exact: true }).click();
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
  await page.getByRole('button', { name: 'Run fuzz', exact: true }).click();
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
  await page.getByRole('button', { name: 'Stop and inspect', exact: true }).click();
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
  await page.waitForFunction(() => document.querySelector('#offline-status').textContent.startsWith('Offline assets verified on this device'));
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.goto(base + '#/capture');
  await page.context().setOffline(true);
  await page.reload(); await waitParsed(page, 'sample-flight.tlog');
  await page.goto(base + '#/frames/0?tab=bytes');
  await page.getByRole('button', { name: 'Edit copy', exact: true }).click();
  await page.getByLabel('Byte offset', { exact: true }).fill('18');
  await page.getByRole('button', { name: 'Flip bit', exact: true }).click();
  await waitParsed(page, 'sample-flight.tlog (modified copy)');
  await page.getByRole('button', { name: 'Close byte editor', exact: true }).click();
  await page.goto(base + '#/capture');
  assert.match(await page.locator('#m-crc').textContent(), /^4/);
  assert.deepEqual(page.errors, []); assert.deepEqual(await cspViolations(page), []);
  await page.context().setOffline(false); await page.close();
});

test('changed worker waits for peer work, activates by consent, then serves final HTML offline', async () => {
  let nextWorker = false;
  const currentWorkerSource = fsSync.readFileSync(path.join(DOCS, 'sw.js'), 'utf8');
  const currentCache = currentWorkerSource.match(/const CACHE = '([^']+)'/)?.[1];
  assert.ok(currentCache, 'the worker declares a versioned offline cache');
  const nextCache = currentCache.replace(/-(\d+)$/, (_, suffix) => `-${Number(suffix) + 1}`);
  const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
    '.woff2': 'font/woff2', '.tlog': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.txt': 'text/plain', '.md': 'text/plain', '.sql': 'text/plain', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
  };
  const root = path.resolve(DOCS);
  const updateServer = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '') || 'index.html'; }
    catch { res.writeHead(400).end(); return; }
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fsSync.existsSync(file) || fsSync.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    let body = fsSync.readFileSync(file);
    if (rel === 'index.html') body = Buffer.from(body.toString('utf8').replace("connect-src 'self';", "connect-src 'self' http://localhost:* http://127.0.0.1:*;"));
    if (rel === 'sw.js' && nextWorker) {
      const source = body.toString('utf8');
      assert.ok(source.includes(currentCache), 'the current worker cache identity is present');
      body = Buffer.from(source.replace(currentCache, nextCache));
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'text/plain', 'cache-control': 'no-store' });
    res.end(body);
  });
  await new Promise(resolve => updateServer.listen(0, '127.0.0.1', resolve));
  const updateBase = `http://127.0.0.1:${updateServer.address().port}/`;
  const context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', error => page.errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) page.errors.push(message.text()); });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', event => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  await page.goto(updateBase + '#/capture');
  await waitParsed(page, 'sample-flight.tlog');
  let peer;
  try {
    await page.waitForFunction(() => document.querySelector('#offline-status').textContent.startsWith('Offline assets verified on this device'));
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    peer = await context.newPage();
    peer.errors = [];
    peer.on('pageerror', error => peer.errors.push(String(error)));
    peer.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) peer.errors.push(message.text()); });
    await peer.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', event => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    peer.on('pageerror', error => { peer.errors.push(String(error)); });
    peer.errors = [];
    await peer.goto(updateBase + '#/capture');
    await waitParsed(peer, 'sample-flight.tlog');
    const sample = await fs.readFile(new URL('../../docs/sample/sample-flight.tlog', import.meta.url));
    await peer.locator('#file').setInputFiles({ name: 'operator-copy.tlog', mimeType: 'application/octet-stream', buffer: sample });
    await waitParsed(peer, 'operator-copy.tlog');

    nextWorker = true;
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting));
    await page.waitForFunction(() => !document.querySelector('#update-notice').hidden);
    const staged = await page.evaluate(async cacheName => {
      const cache = await caches.open(cacheName);
      const response = await cache.match(new URL('index.html', location.href));
      return { text: await response?.text(), keys: (await cache.keys()).length };
    }, nextCache);
    assert.match(staged.text || '', /id="auth-title" tabindex="-1"/);
    assert.ok(staged.keys > 0, 'the new worker staged the complete offline asset set');

    await page.getByRole('button', { name: 'Update and reload', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#update-message').textContent.includes('Another Mavframe tab has work open'));
    assert.equal((await navigatorStatus(page)).cache, currentCache, 'peer work leaves the old worker in control');
    assert.ok(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting)), 'the update remains waiting after peer-busy rejection');

    await peer.close(); peer = null;
    const reloaded = page.waitForNavigation({ waitUntil: 'load' });
    await page.getByRole('button', { name: 'Update and reload', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#update-message').textContent.startsWith('Update accepted.'));
    await reloaded;
    await page.waitForFunction(async cacheName => {
      const worker = navigator.serviceWorker.controller;
      if (!worker) return false;
      const status = await new Promise(resolve => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 1000);
        channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data); };
        worker.postMessage({ type: 'GET_OFFLINE_STATUS' }, [channel.port2]);
      });
      return status?.cache === cacheName && status.ready === true;
    }, nextCache, { timeout: 15000 });
    const activeStatus = await navigatorStatus(page);
    const activation = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return { url: location.href, controller: navigator.serviceWorker.controller?.state, active: registration?.active?.state, waiting: registration?.waiting?.state, caches: await caches.keys() };
    });
    assert.equal(activeStatus.cache, nextCache, JSON.stringify({ activeStatus, activation }));
    assert.equal(activeStatus.ready, true);

    await context.setOffline(true);
    await page.reload();
    await waitParsed(page, 'sample-flight.tlog');
    assert.equal(await page.locator('#auth-title').getAttribute('tabindex'), '-1');
    assert.deepEqual(page.errors, []); assert.deepEqual(await cspViolations(page), []);
    await context.setOffline(false);
  } finally {
    await peer?.close();
    await context.setOffline(false).catch(() => {});
    await context.close();
    await new Promise(resolve => updateServer.close(resolve));
  }
});

test('all tools stay free and Help retains license and trust details without a support solicitation', async () => {
  const page = await open({ hash: '#/help', viewport: { width: 1440, height: 900 } });
  const help = await page.locator('#screen-help').innerText();
  assert.match(help, /All inspection and export tools are free/);
  assert.match(help, /MAVLink packet-loss assumptions/);
  assert.doesNotMatch(help, /\$\d+|proposed support|team support|Support options/);
  assert.equal(await page.locator('#team-options-dialog').count(), 0);
  assert.deepEqual(page.errors, []);
  await page.close();
});
