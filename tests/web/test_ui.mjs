// End-to-end tests of the inspector page in Chromium (Playwright) plus the
// axe-core accessibility gate in light and dark mode.
//
//   node --test tests/web/test_ui.mjs
//   SCREENSHOT=1 node --test tests/web/test_ui.mjs   # also writes docs/screenshots/inspector.png
//
// Needs the playwright and axe-core npm packages (resolved with require()).
// AXE_PATH can point at axe.min.js directly.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS = path.join(ROOT, "docs");
const truth = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/web/sample-truth.json"), "utf8"));
const AXE = process.env.AXE_PATH || require.resolve("axe-core/axe.min.js");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm",
  ".woff2": "font/woff2", ".tlog": "application/octet-stream", ".png": "image/png" };
let server;
let base;
let browser;

before(async () => {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(DOCS, rel);
    if (!file.startsWith(DOCS + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function openPage(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ...opts });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.errors = errors;
  await page.goto(base + (opts.hash || ""));
  await waitParsed(page, "sample-flight.tlog");
  return page;
}

function waitParsed(page, name, timeout = 30000) {
  return page.waitForFunction((n) => {
    const s = document.getElementById("status").textContent;
    return s.startsWith(n + ":") && /valid frames/.test(s) && !document.getElementById("load-sample").disabled;
  }, name, { timeout });
}

const metric = (page, id) => page.$eval(`#${id}`, (dd) => dd.firstChild.textContent.replace(/,/g, ""));

test("Load sample flight shows the generator's exact counts", async () => {
  const page = await openPage();
  await page.getByRole("button", { name: "Load sample flight" }).click();
  await waitParsed(page, "sample-flight.tlog");
  assert.equal(await metric(page, "m-frames"), String(truth.frames));
  assert.equal(await metric(page, "m-crc"), String(truth.crc_errors));
  assert.equal(await metric(page, "m-gaps"), String(truth.gaps));
  assert.equal(await metric(page, "m-skipped"), String(truth.skipped_bytes));
  assert.match(await page.textContent("#m-gaps"), new RegExp(`${truth.missing_frames} frames missing`));
  assert.match(await page.textContent("#source"), /Synthetic sample/);
  // Message table: one row per message type with count and CRC errors.
  const rows = await page.$$eval("#msg-table tbody tr", (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));
  assert.equal(rows.length, Object.keys(truth.messages).length);
  for (const [id, name, , count, , crc] of rows) {
    assert.equal(name, truth.messages[id].name);
    assert.equal(count.replace(/,/g, ""), String(truth.messages[id].count));
    assert.equal(crc, String(truth.messages[id].crc_errors));
  }
  // Timeline markers.
  assert.equal(await page.locator("#timeline g.crc").count(), truth.crc_errors);
  assert.equal(await page.locator("#timeline g.gap").count(), truth.gaps);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("issues, filters, decoding and the URL state work", async () => {
  const page = await openPage();
  await page.getByRole("button", { name: "Next issue" }).click();
  assert.equal(await page.getAttribute("#view-issues", "aria-pressed"), "true");
  assert.equal(await page.locator("#list-table tbody tr").count(), truth.crc_errors + truth.gaps);
  const lead = await page.textContent("#decoded .lead");
  assert.match(lead, /CRC error at offset/);
  assert.match(lead, new RegExp(truth.crc_error_offsets[0].toLocaleString("en-US")));
  assert.match(await page.textContent("#decoded"), /computed 0x[0-9A-F]{4} by mavframe_crc16/);

  // Filter by ATTITUDE and pick a frame: payload fields decoded.
  await page.getByRole("button", { name: "All frames" }).click();
  await page.locator("#msg-table").getByRole("button", { name: "ATTITUDE" }).click();
  assert.match(await page.textContent("#page-info"), new RegExp(`of ${truth.messages["30"].count} frames`));
  await page.locator("#list-table .rowbtn").nth(3).click();
  const decoded = await page.textContent("#decoded");
  assert.match(decoded, /Payload: ATTITUDE/);
  assert.match(decoded, /yawspeed/);
  // Arrow keys move the selection and the focus to the next row.
  const sel = page.locator('#list-table .rowbtn[aria-current="true"]');
  const beforeIdx = Number(await sel.getAttribute("data-idx"));
  await sel.focus();
  await page.keyboard.press("ArrowDown");
  const focused = await page.evaluate(() => [document.activeElement.dataset.idx, document.activeElement.getAttribute("aria-current")]);
  assert.ok(Number(focused[0]) > beforeIdx);
  assert.equal(focused[1], "true");

  // The view is in the URL; opening the link restores it.
  const url = page.url();
  assert.match(url, /#view=frames&msg=30&sel=f\d+/);
  const leadBefore = await page.textContent("#decoded .lead");
  const page2 = await openPage({ hash: url.slice(url.indexOf("#")) });
  assert.equal(await page2.textContent("#decoded .lead"), leadBefore);
  assert.equal(await page2.getAttribute('#msg-table button[aria-pressed="true"]', "aria-pressed"), "true");
  assert.deepEqual([...page.errors, ...page2.errors], []);
  await page.close();
  await page2.close();
});

for (const scheme of ["light", "dark"]) {
  test(`axe-core: 0 violations (${scheme})`, async () => {
    const page = await openPage({ colorScheme: scheme });
    await page.addScriptTag({ path: AXE });
    const run = () => page.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] });
      return { passes: r.passes.length, violations: r.violations.map((v) => `${v.id}: ${v.nodes.length} (${v.nodes[0].target.join(" ")})`) };
    });
    const a = await run();
    assert.deepEqual(a.violations, [], "frame selected");
    assert.ok(a.passes > 20, `axe ran ${a.passes} passing rules`);
    await page.getByRole("button", { name: "Next issue" }).click();
    const b = await run();
    assert.deepEqual(b.violations, [], "CRC issue selected");
    console.log(`# axe ${scheme}: ${a.violations.length} + ${b.violations.length} violations, ${a.passes} and ${b.passes} rules passed`);
    await page.close();
  });
}

test("no horizontal page scroll at 320 px", async () => {
  const page = await openPage({ viewport: { width: 320, height: 800 } });
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  assert.ok(scroll <= width, `page is ${scroll}px wide in a ${width}px viewport`);
  await page.close();
});

test("a 50 MB capture is parsed in chunks without freezing the page", async () => {
  const page = await openPage();
  const sample = fs.readFileSync(path.join(ROOT, truth.file));
  const copies = Math.ceil((50 * 1024 * 1024) / sample.length);
  const big = Buffer.concat(Array(copies).fill(sample));
  await page.evaluate(() => {
    window.__probe = { maxGap: 0, last: performance.now(), progress: new Set() };
    window.__probe.timer = setInterval(() => {
      const now = performance.now();
      window.__probe.maxGap = Math.max(window.__probe.maxGap, now - window.__probe.last);
      window.__probe.last = now;
      const p = document.getElementById("progress");
      if (!p.hidden) window.__probe.progress.add(p.value);
    }, 10);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavframe-ui-"));
  const bigPath = path.join(dir, "big.tlog");
  fs.writeFileSync(bigPath, big);
  await page.setInputFiles("#file", bigPath);
  await waitParsed(page, "big.tlog", 180000);
  const probe = await page.evaluate(() => {
    clearInterval(window.__probe.timer);
    return { maxGap: window.__probe.maxGap, progress: [...window.__probe.progress] };
  });
  assert.equal(await metric(page, "m-frames"), String(truth.frames * copies));
  assert.equal(await metric(page, "m-crc"), String(truth.crc_errors * copies));
  const midway = probe.progress.filter((v) => v > 0 && v < 100);
  assert.ok(midway.length >= 5, `progress values seen: ${probe.progress.join(",")}`);
  console.log(`# 50 MB test: ${big.length} bytes, longest main-thread gap ${probe.maxGap.toFixed(0)} ms, ${midway.length} progress steps seen`);
  assert.ok(probe.maxGap < 250, `main thread blocked for ${probe.maxGap.toFixed(0)} ms`);
  fs.rmSync(dir, { recursive: true });
  await page.close();
});

test("screenshot for the README", { skip: !process.env.SCREENSHOT }, async () => {
  const page = await openPage({ viewport: { width: 1440, height: 1060 }, deviceScaleFactor: 2, colorScheme: "light" });
  await page.getByRole("button", { name: "Next issue" }).click();
  await page.evaluate(() => document.activeElement.blur());
  fs.mkdirSync(path.join(DOCS, "screenshots"), { recursive: true });
  await page.screenshot({ path: path.join(DOCS, "screenshots", "inspector.png") });
  await page.close();
});
