import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium, DOCS, waitParsed } from './browser.mjs';

test('the install manifest is permitted only from the app origin', () => {
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const directives = policy.split(';').map(part => part.trim());
  assert.ok(directives.includes("default-src 'none'"));
  assert.ok(directives.includes("manifest-src 'self'"));
});

test('Pages Markdown/SQL MIME types cache offline; HTML substitutions fail visibly without replacing a working worker', async () => {
  const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
    '.woff2': 'font/woff2', '.tlog': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.txt': 'text/plain', '.md': 'text/markdown', '.sql': 'application/sql', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
  };
  let invalid = '';
  let revision = 0;
  const server = http.createServer((req, res) => {
    const relative = new URL(req.url, 'http://local').pathname.replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(DOCS, relative);
    if (!file.startsWith(DOCS + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    const ext = path.extname(file);
    let body = fs.readFileSync(file);
    if (relative === 'sw.js') body = Buffer.from(body.toString().replace(/const CACHE = '([^']+)'/, (_, cache) => `const CACHE = '${cache}-mime-${revision}'`));
    const bad = ext === invalid;
    res.writeHead(200, { 'content-type': bad ? 'text/html' : types[ext] || 'text/plain', 'cache-control': 'no-store' });
    res.end(bad ? '<!doctype html><title>Wrong asset</title>' : body);
  });
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const contexts = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'allow' }); contexts.push(context);
    const page = await context.newPage();
    await page.goto(base + '#/capture');
    await waitParsed(page, 'sample-flight.tlog');
    await page.waitForFunction(() => document.querySelector('#offline-status').textContent.startsWith('Offline assets verified'), null, { timeout: 10000 });
    assert.ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
    await context.setOffline(true);
    await page.reload();
    await waitParsed(page, 'sample-flight.tlog');
    await context.setOffline(false);
    // Parsing can finish before the worker's independent status response.
    await page.waitForFunction(() => document.querySelector('#offline-status').textContent.startsWith('Offline assets verified'), null, { timeout: 10000 });

    // A failed update must preserve the previous, complete offline worker.
    invalid = '.md'; revision++;
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await new Promise(async (resolve, reject) => {
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker.addEventListener('statechange', () => { if (worker.state === 'redundant') resolve(); });
        }, { once: true });
        try { await registration.update(); } catch (error) { reject(error); }
      });
    });
    await page.waitForFunction(() => document.querySelector('#offline-status').textContent.startsWith('Offline assets verified'), null, { timeout: 10000 });
    await page.locator('.support-tools > summary').click();
    assert.equal(await page.locator('#offline-status').isVisible(), true);
    assert.match(await page.locator('#offline-status').innerText(), /^Offline assets verified/);
    assert.equal(await page.locator('#offline-status').getAttribute('data-state'), 'ready');
    await context.setOffline(true);
    await page.reload(); await waitParsed(page, 'sample-flight.tlog');
    await context.setOffline(false);

    for (const ext of ['.md', '.sql', '.wasm']) {
      invalid = ext; revision++;
      const failedContext = await browser.newContext({ serviceWorkers: 'allow' }); contexts.push(failedContext);
      const failedPage = await failedContext.newPage();
      await failedPage.goto(base + '#/capture');
      await failedPage.waitForFunction(() => document.querySelector('#offline-status').dataset.state === 'error', null, { timeout: 10000 });
      await failedPage.locator('.support-tools > summary').click();
      assert.equal(await failedPage.locator('#offline-status').isVisible(), true);
      assert.match(await failedPage.locator('#offline-status').innerText(), /failed.*Reconnect.*reload/);
      assert.equal(await failedPage.evaluate(() => navigator.serviceWorker.controller), null);
      assert.deepEqual(await failedPage.evaluate(() => caches.keys()), []);
      await failedContext.close();
    }
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
