import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, startServer } from "./browser.mjs";
let server, base, browser;
before(async () => {
  if (process.env.MAVFRAME_BASE_URL) base = process.env.MAVFRAME_BASE_URL.replace(/\/?$/, '/');
  else ({server, base} = await startServer());
  browser = await chromium.launch(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {});
});
after(async () => { await browser?.close(); server?.close(); });
for (const [route, title] of [["", "Overview"], ["overview", "Overview"], ["workbench", "Workbench"], ["reports", "Reports"], ["settings", "Settings"], ["anomalies", "Anomaly analysis"], ["stream", "Hex / binary comparison"], ["system", "Health and metrics"]]) {
  test(`direct /${route} and refresh show ${title}`, async () => {
    const page = await browser.newPage({serviceWorkers:"block"});
    await page.goto(base + route);
    await page.waitForFunction(() => [...document.querySelectorAll("h1")].some(h => h.offsetParent !== null));
    assert.equal(await page.locator("h1:visible").textContent(), title);
    await page.reload();
    await page.waitForFunction(t => document.title.includes(t), title);
    assert.equal(await page.locator("h1:visible").textContent(), title);
    await page.close();
  });
}

test('exact-path filters, packet selection, Back/Forward and tabs preserve the loaded capture', async () => {
  const context = await browser.newContext({serviceWorkers:'block', viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  await page.goto(base + 'workbench');
  await page.waitForFunction(() => !document.querySelector('#load-sample').disabled);
  await page.locator('#load-sample').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'sample-flight.tlog loaded.');
  const {default:fs} = await import('node:fs/promises');
  const sample = await fs.readFile(new URL('../../docs/sample/sample-flight.tlog', import.meta.url));
  await page.locator('#file').setInputFiles({name:'tab-a.tlog', mimeType:'application/octet-stream', buffer:sample});
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'tab-a.tlog loaded.');
  await page.locator('[data-product-route="anomalies"]').click();
  await page.getByRole('button', {name:'CRC failed', exact:true}).click();
  assert.match(page.url(), /\/anomalies\?check=crc$/);
  assert.equal(await page.locator('#frame-table tbody tr').count(), 3);
  await page.locator('#frame-table tbody a').first().click();
  assert.match(page.url(), /\/anomalies\?check=crc&row=\d+$/);
  assert.match(await page.locator('#crc-compare').innerText(), /Mismatch: CRC failed/);
  assert.match(await page.locator('#frames-counts').innerText(), /tab-a.tlog/);
  await page.locator('[data-product-route="stream"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(new URL(page.url()).pathname, '/stream');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'H1');
  await page.goBack();
  assert.match(page.url(), /check=crc&row=/);
  await page.goForward();
  assert.equal(new URL(page.url()).pathname, '/stream');
  const other = await context.newPage();
  await other.goto(base + 'anomalies?check=unsupported&msg=30');
  await other.waitForSelector('#frames-body');
  await page.locator('.canonical-nav [data-canonical="workbench"]').click();
  await page.locator('#file').setInputFiles({name:'empty.bin', mimeType:'application/octet-stream', buffer:Buffer.alloc(0)});
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('empty (0 bytes)'));
  assert.equal(new URL(other.url()).search, '?check=unsupported&msg=30');
  assert.equal(await other.locator('#msg-filter').inputValue(), '30');
  await context.close();
});

test('system reports actual response data and a controlled dependency failure', async () => {
  const page = await browser.newPage({serviceWorkers:'block'});
  let ready = true;
  await page.route('**/healthz', route => route.fulfill({json:{status:'ok'}}));
  await page.route('**/readyz', route => route.fulfill({status:ready ? 200 : 503, json:{status:ready ? 'ready':'not_ready'}}));
  await page.route('**/api/system', route => route.fulfill({json:{service:'mavframe',status:'ready',uptime_seconds:12,http:{requests_total:7,errors_total:2},scope:'Test fixture HTTP process'}}));
  await page.route('**/metrics', route => route.fulfill({contentType:'text/plain',body:'# TYPE test_requests_total counter\ntest_requests_total 7\n'}));
  await page.goto(base + 'system');
  await page.waitForFunction(() => document.querySelector('#system-status').textContent.startsWith('Checked'));
  assert.match(await page.locator('#system-values').innerText(), /12/);
  assert.match(await page.locator('#system-metrics').textContent(), /test_requests_total 7/);
  ready = false;
  await page.getByRole('button',{name:'Refresh service data'}).click();
  await page.waitForFunction(() => document.querySelector('#system-status').textContent.startsWith('Some'));
  assert.match(await page.locator('#system-checks').innerText(), /Readiness: unavailable \(HTTP 503\)/);
  await page.close();
});

for (const width of [320,375,768,1024,1440]) {
  test(`all product routes reflow, pass axe and capture evidence at ${width}px`, async () => {
    const { axeViolations, smallTargets, waitParsed, cspViolations } = await import('./browser.mjs');
    const { default:fs } = await import('node:fs/promises');
    const out = process.env.MAVFRAME_EVIDENCE_DIR ? new URL(process.env.MAVFRAME_EVIDENCE_DIR + '/', 'file:///') : new URL('../../artifacts/verification/post-restart/', import.meta.url);
    await fs.mkdir(out,{recursive:true});
    const page = await browser.newPage({serviceWorkers:'block',viewport:{width,height:1000}});
    const errors=[];page.on('pageerror',e => errors.push(e.stack));
    await page.addInitScript(() => { window.__csp=[]; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective)); });
    await page.goto(base + 'workbench');
    await page.waitForFunction(() => !document.querySelector('#load-sample').disabled);
    await page.locator('#load-sample').click();
    await waitParsed(page,'sample-flight.tlog');
    for (const [route, title] of [['workbench','Workbench'],['anomalies','Anomaly analysis'],['stream','Hex / binary comparison'],['settings','Settings']]) {
      if (width < 1000 && ["workbench", "settings"].includes(route)) await page.locator("#menu-btn").click();
      await page.locator(["workbench", "settings"].includes(route) ? `.canonical-nav [data-canonical="${route}"]` : `[data-product-route="${route}"]`).click();
      await page.waitForFunction(t => document.title.startsWith(t),title);
      assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1),true, `${route} root overflow`);
      assert.deepEqual(await smallTargets(page),[],route);
      const scan=await axeViolations(page);
      assert.deepEqual(scan.violations,[],route);
      await page.screenshot({path:new URL(`product-${route}-${width}.png`,out).pathname,fullPage:true});
    }
    assert.deepEqual(errors,[]);
    assert.deepEqual(await cspViolations(page),[]);
    await page.close();
  });
}


test('anomaly All filter is explicit and missing API/assets remain 404', async () => {
  const page = await browser.newPage({serviceWorkers:'block'});
  await page.goto(base + 'anomalies');
  await page.locator('#scenario-select').selectOption('crc');
  await page.locator('#run-scenario').click();
  await page.waitForSelector('#frame-table tbody a');
  await page.getByRole('button',{name:'All',exact:true}).click();
  assert.equal(new URL(page.url()).searchParams.get('check'),'all');
  assert.equal(await page.getByRole('button',{name:'All',exact:true}).getAttribute('aria-pressed'),'true');
  for (const missing of ['api/missing','js/missing.js','missing']) {
    const response = await page.request.get(base + missing);
    assert.equal(response.status(),404,missing);
  }
  await page.close();
});

test('all exact routes reopen offline after public assets are verified', async () => {
  const context=await browser.newContext({serviceWorkers:'allow'});
  const page=await context.newPage();
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#offline-status').textContent.startsWith('Offline assets verified on this device'));
  await context.setOffline(true);
  for (const route of ['anomalies','stream','system']) {
    await page.goto(base + route);
    await page.waitForFunction(() => document.querySelector('.canonical-nav [aria-current="page"]') !== null);
    assert.equal(await page.locator(`.canonical-nav [data-canonical="${route === 'system' ? 'settings' : 'workbench'}"]`).getAttribute('aria-current'),'page');
  }
  await page.waitForFunction(() => document.querySelector('#system-status').textContent.startsWith('Some'));
  assert.equal(await page.locator('#system-checks .system-failure').count(),4);
  await context.setOffline(false);
  await context.close();
});

test('mobile utility disclosures retain focus inside the menu and close before the sheet', async () => {
  const page = await browser.newPage({serviceWorkers:'block',viewport:{width:375,height:812}});
  await page.goto(base + '#/capture');
  await page.locator('#menu-btn').click();
  await page.locator('#account-menu > summary').click();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').getAttribute('id'),'profile-link');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#account-menu').getAttribute('open'),null);
  assert.equal(await page.locator('#menu-btn').getAttribute('aria-expanded'),'true');
  assert.equal(await page.locator(':focus').getAttribute('id'),'account-label');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#menu-btn').getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator(':focus').getAttribute('id'),'menu-btn');
  await page.locator('#menu-btn').click();
  await page.locator('.support-tools > summary').click();
  const panel = await page.locator('.support-panel').boundingBox();
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 375, JSON.stringify(panel));
  await page.locator('.support-tools > summary').press('Escape');
  assert.equal(await page.locator('.support-tools').getAttribute('open'),null);
  await page.close();
});
