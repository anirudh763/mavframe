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
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS = path.join(ROOT, "docs");
const truth = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/web/sample-truth.json"), "utf8"));
const AXE = process.env.AXE_PATH || require.resolve("axe-core/axe.min.js");
const CASES = fs.mkdtempSync(path.join(os.tmpdir(), "mavframe-ui-cases-"));
{
  const gen = spawnSync("python3", [path.join(ROOT, "tests/web/gen_cases.py"), CASES]);
  assert.equal(gen.status, 0, gen.stderr.toString());
}

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
  const { hash, route, noWait, ...ctx } = opts;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ...ctx });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.errors = errors;
  if (route) await route(page);
  // Record Content-Security-Policy violations (the page's CSP forbids inline code).
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto(base + (hash || ""));
  if (!noWait) await waitParsed(page, "sample-flight.tlog");
  return page;
}

const statusText = (page) => page.textContent("#status");
const cspViolations = (page) => page.evaluate(() => window.__csp);
// axe is evaluated through the DevTools protocol, not injected as a <script>, so the CSP stays on.
const AXE_SOURCE = fs.readFileSync(AXE, "utf8");
const injectAxe = (page) => page.evaluate(AXE_SOURCE);
async function upload(page, file) {
  await page.setInputFiles("#file", file);
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
  // While the sample downloads, the old result's status must not stay up
  // (tests and screen-reader users would read it as the new result).
  await page.route("**/sample/sample-flight.tlog", async (r) => { await new Promise((ok) => setTimeout(ok, 400)); await r.continue(); });
  await page.getByRole("button", { name: "Load sample flight" }).click();
  assert.match(await statusText(page), /^Loading sample-flight.tlog/);
  assert.equal(await page.isDisabled("#load-sample"), true);
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
  for (const [id, name, count, , crc] of rows) {
    assert.equal(name, truth.messages[id].name);
    assert.equal(count.replace(/,/g, ""), String(truth.messages[id].count));
    assert.equal(crc, String(truth.messages[id].crc_errors));
  }
  // Rates per sender for a message two systems send.
  const hb = await page.textContent("#msg-table tbody tr:first-child");
  assert.match(hb, /1:1 at 1\.00 Hz/);
  assert.match(hb, /255:190 at 1\.00 Hz/);
  assert.match(hb, /2\.00 all/);
  // GPS_RAW_INT yaw 0 means "not provided" (official XML: invalid="0").
  await page.locator("#msg-table").getByRole("button", { name: "GPS_RAW_INT" }).click();
  await page.locator("#list-table .rowbtn").first().click();
  assert.match(await page.textContent("#decoded"), /yaw \(extension\)\s*0\s*cdeg\s*not provided/);
  await page.locator("#msg-table").getByRole("button", { name: "GPS_RAW_INT" }).click();
  assert.deepEqual(await cspViolations(page), [], "CSP violations");
  // The external link must not replace the loaded capture.
  assert.equal(await page.getAttribute("#gap-assumptions a", "target"), "_blank");
  assert.match(await page.getAttribute("#gap-assumptions a", "rel"), /noopener/);
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
    await injectAxe(page);
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
    assert.deepEqual(await cspViolations(page), [], "CSP violations");
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

test("keyboard only: load the sample, step to an issue, move through rows", async () => {
  const page = await openPage();
  async function tabTo(selector, max = 80) {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate((sel) => document.activeElement === document.querySelector(sel), selector)) return;
    }
    throw new Error(`could not reach ${selector} with Tab`);
  }
  await tabTo("#load-sample");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.notEqual(outline, "none", "focus indicator visible");
  await page.route("**/sample/sample-flight.tlog", async (r) => { await new Promise((ok) => setTimeout(ok, 400)); await r.continue(); });
  await page.keyboard.press("Enter");
  assert.match(await statusText(page), /^Loading sample-flight.tlog/);
  await waitParsed(page, "sample-flight.tlog");
  await page.waitForFunction(() => document.activeElement.id === "load-sample");
  await tabTo("#next-issue");
  await page.keyboard.press("Enter");
  assert.match(await page.textContent("#decoded .lead"), /CRC error at offset/);
  await tabTo('#list-table .rowbtn[aria-current="true"]');
  await page.keyboard.press("ArrowDown");
  assert.match(await page.textContent("#decoded .lead"), /Sequence gap|frame/);
  await tabTo("#file");
  await tabTo("#format");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("375 px width and 200% zoom: no horizontal page scroll, controls on screen", async () => {
  for (const [label, opts] of [
    ["375 px", { viewport: { width: 375, height: 800 } }],
    ["200% page zoom of a 1280 px window", { viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 }],
  ]) {
    const page = await openPage(opts);
    const r = await page.evaluate(() => {
      const ids = ["load-sample", "next-issue", "view-issues", "m-frames", "m-crc", "m-unsupported"];
      return { scroll: document.documentElement.scrollWidth, width: window.innerWidth,
        out: ids.filter((id) => { const b = document.getElementById(id).getBoundingClientRect(); return b.right > window.innerWidth + 0.5 || b.left < 0; }) };
    });
    assert.ok(r.scroll <= r.width, `${label}: page is ${r.scroll}px wide in a ${r.width}px viewport`);
    assert.deepEqual(r.out, [], `${label}: controls outside the viewport`);
    if (label === "375 px") assert.equal(await page.isVisible(".scroll-hint"), true, "sideways-scroll hint for the messages table");
    await page.close();
  }
  // 200% text size (browser text-only zoom) at 1280 px.
  const page = await openPage({ viewport: { width: 1280, height: 900 } });
  await page.evaluate(() => { document.documentElement.style.fontSize = "30px"; }); // CSSOM: allowed by the CSP
  const r = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  assert.ok(r.scroll <= r.width, `200% text: page is ${r.scroll}px wide`);
  await page.close();
});

test("error states: empty file, not a MAVLink file, oversized file, network failures", async () => {
  const page = await openPage();
  const empty = path.join(CASES, "empty.tlog");
  fs.writeFileSync(empty, Buffer.alloc(0));
  await upload(page, empty);
  await page.waitForFunction(() => /is empty/.test(document.getElementById("status").textContent));
  assert.ok(await page.$eval("#status", (e) => e.classList.contains("error")));
  assert.equal(await metric(page, "m-frames"), String(truth.frames), "the previous capture stays on screen");

  const bad = path.join(CASES, "notes.txt");
  fs.writeFileSync(bad, "This is a text file, not telemetry.\n".repeat(200));
  await upload(page, bad);
  await page.waitForFunction(() => /No MAVLink v2 frames found in notes.txt/.test(document.getElementById("status").textContent));
  assert.equal(await metric(page, "m-frames"), "0");
  assert.match(await page.textContent("#list-table tbody"), /No frames to show/);

  // A file over the size limit is refused before it is read.
  await page.evaluate(() => {
    const input = document.getElementById("file");
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(16)], "huge.tlog"));
    input.files = dt.files;
    Object.defineProperty(input.files[0], "size", { value: 300 * 1024 * 1024 });
    input.dispatchEvent(new Event("change"));
  });
  await page.waitForFunction(() => /huge.tlog is 300 MB.*up to 256 MB/.test(document.getElementById("status").textContent));
  assert.deepEqual(page.errors, []);
  await page.close();

  const noSample = await openPage({ noWait: true, route: (p) => p.route("**/sample/sample-flight.tlog", (r) => r.abort()) });
  await noSample.waitForFunction(() => /Could not load the sample/.test(document.getElementById("status").textContent));
  assert.ok(await noSample.$eval("#status", (e) => e.classList.contains("error")));
  assert.equal(await noSample.isEnabled("#file"), true, "a local file can still be opened");
  await noSample.close();

  const noWasm = await openPage({ noWait: true, route: (p) => p.route("**/mavframe.wasm", (r) => r.abort()) });
  await noWasm.waitForFunction(() => /Could not load the parser/.test(document.getElementById("status").textContent));
  await noWasm.close();
});

test("parsing can be cancelled; the previous capture stays", async () => {
  const page = await openPage();
  const sample = fs.readFileSync(path.join(ROOT, truth.file));
  const big = path.join(CASES, "cancel.tlog");
  fs.writeFileSync(big, Buffer.concat(Array(400).fill(sample)));
  await upload(page, big);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForFunction(() => /Cancelled parsing cancel.tlog. Still showing sample-flight.tlog/.test(document.getElementById("status").textContent));
  assert.equal(await metric(page, "m-frames"), String(truth.frames));
  assert.equal(await page.isHidden("#cancel"), true);
  assert.equal(await page.isEnabled("#load-sample"), true);
  await page.close();
});

test("signed frames say 'signature present; not verified'", async () => {
  const page = await openPage();
  await upload(page, path.join(CASES, "signed.tlog"));
  await waitParsed(page, "signed.tlog");
  assert.equal(await metric(page, "m-frames"), "20");
  await page.locator("#list-table .rowbtn").nth(2).click();
  const decoded = await page.textContent("#decoded");
  assert.match(decoded, /signature present; not verified/);
  assert.doesNotMatch(decoded.replace(/not verified/g, ""), /verified|valid signature|authentic/i);
  assert.match(await page.textContent("#list-table tbody"), /signature present; not verified/);
  assert.equal(await page.locator("#hex .seg-sig").count(), 13);
  await page.close();
});

test("unknown message ids are shown as unsupported, separate from CRC errors", async () => {
  const page = await openPage();
  await upload(page, path.join(CASES, "malformed.bin"));
  await page.waitForFunction(() => /^malformed.bin:/.test(document.getElementById("status").textContent) && !document.getElementById("load-sample").disabled);
  assert.ok(Number(await metric(page, "m-unsupported")) >= 1);
  assert.ok(Number(await metric(page, "m-crc")) >= 1);
  await page.getByRole("button", { name: /^Issues/ }).click();
  const kinds = await page.$$eval("#list-table tbody .kind", (els) => els.map((e) => e.textContent));
  assert.ok(kinds.includes("Unsupported id") && kinds.includes("CRC error") && kinds.includes("Bad flags"), kinds.join(","));
  await page.locator("#list-table tbody tr", { hasText: "Unsupported id" }).first().locator(".rowbtn").click();
  const decoded = await page.textContent("#decoded");
  assert.match(decoded, /not counted as corrupt/);
  await injectAxe(page);
  const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] })).violations.map((x) => x.id));
  assert.deepEqual(v, [], "axe on the issue view of a malformed capture");
  await page.close();
});

test("duplicate and backward sequence numbers are labelled, not shown as missing frames", async () => {
  const page = await openPage();
  for (const [file, kind] of [["seq-duplicate.bin", "Duplicate seq"], ["seq-backwards.bin", "Out of order"]]) {
    await upload(page, path.join(CASES, file));
    await waitParsed(page, file);
    assert.equal(await metric(page, "m-gaps"), "0", file);
    assert.match(await page.textContent("#m-gaps"), /~0 frames missing if packets arrived in order/);
    assert.equal(await metric(page, "m-crc"), "0");
    await page.getByRole("button", { name: /^Issues/ }).click();
    assert.deepEqual(await page.$$eval("#list-table tbody .kind", (els) => els.map((e) => e.textContent)), [kind]);
    await page.locator("#list-table .rowbtn").first().click();
    assert.match(await page.textContent("#decoded"), /Not counted as missing/);
  }
  await page.close();
});

test("focus stays on a control after activating rows, message filters and the pager", async () => {
  const page = await openPage();
  const active = () => page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a.tagName, id: a.id, cls: a.className, msgid: a.dataset.msgid || null, current: a.getAttribute("aria-current") };
  });
  // Enter on a frame row.
  await page.locator("#list-table .rowbtn").nth(2).focus();
  await page.keyboard.press("Enter");
  let a = await active();
  assert.notEqual(a.tag, "BODY", "after Enter on a row");
  assert.equal(a.current, "true");
  // Enter and Space on a message filter button.
  for (const key of ["Enter", "Space"]) {
    await page.locator("#msg-table").getByRole("button", { name: "ATTITUDE" }).focus();
    await page.keyboard.press(key);
    a = await active();
    assert.notEqual(a.tag, "BODY", `after ${key} on a message filter`);
    assert.equal(a.msgid, "30");
  }
  // Next page until the last page: the button becomes disabled, focus moves to Previous page.
  await page.locator("#msg-table").getByRole("button", { name: "ATTITUDE" }).press("Enter"); // clear the filter if set
  if (!(await page.isHidden("#filter"))) await page.getByRole("button", { name: "Clear filter" }).click();
  await page.locator("#next-page").focus();
  while (!(await page.isDisabled("#next-page"))) await page.keyboard.press("Enter");
  a = await active();
  assert.notEqual(a.tag, "BODY", "after Next page reached the last page");
  assert.equal(a.id, "prev-page");
  assert.match(await page.textContent("#page-info"), new RegExp(`of ${truth.frames.toLocaleString("en-US")} frames`));
  await page.close();
});
