// Root visual gate for the light, routed inspector (Capture / Frames /
// Frame details / Format help) in Chromium with Playwright and axe-core.
//
//   node --test tests/web/test_routes.mjs
//   SCREENSHOT=1 node --test tests/web/test_routes.mjs   # also writes docs/screenshots/frames-*.png
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, DOCS, truth, startServer, openPage as open, waitParsed, cspViolations, axeViolations, settle, smallTargets } from "./browser.mjs";

let server;
let base;
let browser;
before(async () => {
  ({ server, base } = await startServer());
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});
const openPage = (opts) => open(browser, base, opts);

// The CSP shipped on origin/main; the rebuild must keep it (or make it stricter).
const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

const h1Text = (page) => page.evaluate(() => [...document.querySelectorAll("h1")].find((h) => h.offsetParent !== null)?.textContent.trim());
const focusedH1 = (page) => page.evaluate(() => document.activeElement.tagName === "H1" ? document.activeElement.textContent.trim() : null);
const waitRoute = (page, re) => page.waitForFunction((src) => new RegExp(src).test(location.hash), re.source);

// Row index (in #/frames/<index>) of the row at a byte offset, read from the rendered Frames table.
async function rowHref(page, offset) {
  await page.goto(base + "#/frames?check=crc");
  await page.waitForSelector("#frame-table tbody tr a");
  return page.$eval(`#frame-table tbody tr[data-off="${offset}"] a`, (a) => a.getAttribute("href"));
}

const SCREENS = ["#/capture", "#/frames", "#/frames/DETAIL", "#/help"];
async function screenHashes(page) {
  const href = await rowHref(page, 13866);
  return SCREENS.map((s) => (s === "#/frames/DETAIL" ? href : s));
}

test("default screen is Capture with a sample load and the fixture labelled as an engineering fixture", async () => {
  const page = await openPage();
  assert.equal(await h1Text(page), "Capture");
  assert.equal(await page.title(), "Capture – Mavframe");
  assert.match(await page.textContent("#source"), /Engineering fixture/);
  assert.match(await page.textContent("#source"), /not a real flight/);
  assert.equal(await page.locator('nav[aria-label="Main"] a[aria-current="page"]').textContent(), "Capture");
  assert.equal(await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', "content"), CSP, "CSP unchanged");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("Frames shows actual rows: time, offset, message, sys:comp, seq and CRC status, with a filter", async () => {
  const page = await openPage({ hash: "#/frames" });
  assert.equal(await h1Text(page), "Frames");
  const head = await page.$$eval("#frame-table thead th", (ths) => ths.map((t) => t.textContent.trim()));
  assert.deepEqual(head.slice(0, 6), ["Check", "Message", "Time (s)", "Offset", "Sys:Comp", "Seq"]);
  const first = await page.$$eval("#frame-table tbody tr:first-child td", (tds) => tds.map((t) => t.textContent.trim()));
  assert.deepEqual(first.slice(0, 6), ["Valid CRC", "HEARTBEAT", "0.000", "8", "1:1", "0"]);
  // The table scrolls inside its own labelled region.
  assert.equal(await page.getAttribute("#frame-region", "role"), "region");
  assert.ok(await page.getAttribute("#frame-region", "aria-label"));
  // Filter to CRC failures: exactly the generator's three offsets, each labelled in text.
  await page.getByRole("button", { name: "CRC failed", exact: true }).click();
  await waitRoute(page, /check=crc/);
  const rows = await page.$$eval("#frame-table tbody tr", (trs) => trs.map((tr) => [tr.dataset.off, tr.cells[0].textContent.trim(), tr.cells[1].textContent.trim()]));
  assert.deepEqual(rows.map((r) => Number(r[0])), truth.crc_error_offsets);
  assert.deepEqual(rows.map((r) => r[1]), ["CRC failed", "CRC failed", "CRC failed"]);
  assert.equal(rows[0][2], "ATTITUDE");
  // Message filter (select), combined with the check filter; Clear resets both.
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.selectOption("#msg-filter", "30");
  await waitRoute(page, /msg=30/);
  assert.match(await page.textContent("#page-info"), new RegExp(`of ${truth.messages["30"].count + 1} rows`));
  // Sequence-gap estimates carry their channel assumption on this screen.
  assert.match(await page.textContent("#screen-frames"), /one fully observed channel/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("CRC failure and unsupported message ids stay separate filters and labels", async () => {
  const page = await openPage();
  const { default: os } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavframe-routes-"));
  assert.equal(spawnSync("python3", [path.join(DOCS, "..", "tests/web/gen_cases.py"), dir]).status, 0);
  await page.setInputFiles("#file", path.join(dir, "malformed.bin"));
  await page.waitForFunction(() => /^malformed.bin:/.test(document.getElementById("status").textContent) && !document.getElementById("load-sample").disabled);
  await page.goto(base + "#/frames?check=unsupported");
  await page.waitForSelector("#frame-table tbody tr");
  const unsup = await page.$$eval("#frame-table tbody tr", (trs) => trs.map((tr) => tr.cells[0].textContent.trim()));
  assert.ok(unsup.includes("Unsupported (not checked)") && unsup.every((t) => /\(not checked\)$/.test(t)), unsup.join(","));
  await page.getByRole("button", { name: "CRC failed", exact: true }).click();
  const crc = await page.$$eval("#frame-table tbody tr", (trs) => trs.map((tr) => tr.cells[0].textContent.trim()));
  assert.ok(crc.length >= 1 && crc.every((t) => t === "CRC failed"), crc.join(","));
  fs.rmSync(dir, { recursive: true });
  await page.close();
});

test("packet analyzer (1440 px): list, field tree and bytes side by side; field and byte selection are linked both ways", async () => {
  const page = await openPage();
  await page.goto(base + "#/frames?msg=30");
  await page.waitForSelector("#frame-table tbody tr a");
  // A valid ATTITUDE frame: clicking its row keeps the list and focus, and fills the detail panes.
  const row = page.locator("#frame-table tbody tr", { hasText: "Valid CRC" }).first();
  const off = Number(await row.getAttribute("data-off"));
  await row.locator("a").click();
  await waitRoute(page, /^#\/frames\/\d+\?msg=30/);
  // The selection stays on the Frames screen: title, H1 and breadcrumb all say Frames.
  assert.equal(await page.title(), "Frames – Mavframe");
  assert.equal(await h1Text(page), "Frames", "still the Frames screen");
  assert.deepEqual(await page.$$eval('nav[aria-label="Breadcrumb"] li', (l) => l.map((x) => x.textContent)), ["Mavframe", "Frames"]);
  assert.equal(await page.isVisible("#back-link"), false, "no Back on the non-contextual screen");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-current")), "true", "focus stays on the selected row");
  assert.equal(await page.textContent("#detail-title"), `ATTITUDE at offset ${off.toLocaleString("en-US")}`);
  for (const sel of ["#frame-region", "#panel-header", "#panel-decoded", "#hex"]) assert.ok(await page.isVisible(sel), `${sel} visible`);
  assert.equal(await page.isVisible("#tablist"), false, "no tabs when all panes fit");
  const hexFit = await page.$eval("#hex", (e) => [e.scrollWidth, e.clientWidth]);
  assert.ok(hexFit[0] <= hexFit[1], `hex rows (with ASCII) fit the pane: ${hexFit.join(" > ")}`);
  assert.match(await page.textContent("#crc-compare"), /Match: valid CRC/);
  // Field -> bytes: pitch is a float at payload offset 8.
  await page.locator("#panel-decoded").getByRole("button", { name: "pitch", exact: true }).click();
  const hl = await page.$$eval("#hex .b.hl", (s) => s.map((x) => Number(x.dataset.o)));
  assert.deepEqual(hl, [off + 18, off + 19, off + 20, off + 21]);
  await waitRoute(page, /f=p\.pitch/);
  // Bytes -> field: clicking a byte of roll (payload offset 4) selects roll.
  await page.click(`#hex .b[data-o="${off + 15}"]`);
  assert.equal(await page.getAttribute('#panel-decoded .fieldbtn[data-key="p.roll"]', "aria-pressed"), "true");
  assert.equal(await page.locator("#hex .b.hl").count(), 4);
  // Keyboard alternative: with the bytes focused, ArrowRight selects the next field.
  await page.focus("#hex");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getAttribute('#panel-decoded .fieldbtn[data-key="p.pitch"]', "aria-pressed"), "true");
  assert.match(await page.textContent("#field-status"), /pitch: 4 bytes/);
  // Header fields link too: Sequence is one byte at frame offset 4.
  await page.locator("#panel-header").getByRole("button", { name: "Sequence" }).click();
  assert.deepEqual(await page.$$eval("#hex .b.hl", (s) => s.map((x) => Number(x.dataset.o))), [off + 4]);
  // The selection survives a reload (it is in the URL).
  await page.reload();
  await waitParsed(page, "sample-flight.tlog");
  assert.deepEqual(await page.$$eval("#hex .b.hl", (s) => s.map((x) => Number(x.dataset.o))), [off + 4]);
  // Arrow keys in the list move the selection like a packet list.
  const link = page.locator('#frame-table a[aria-current="true"]');
  const before = await link.getAttribute("data-pos");
  await link.focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction((b) => document.activeElement.dataset.pos !== b && document.activeElement.getAttribute("aria-current") === "true", before);
  assert.deepEqual(page.errors, []);
  await page.close();
});

for (const [width, height] of [[1440, 900], [1024, 768]]) {
  test(`packet analyzer at ${width}x${height}: after a row click the list, field tree and bytes are all inside the viewport`, async () => {
    const page = await openPage({ viewport: { width, height } });
    await page.goto(base + "#/frames");
    await page.waitForSelector("#frame-table tbody tr a");
    await page.locator("#frame-table tbody tr a").nth(3).click();
    await waitRoute(page, /^#\/frames\/3/);
    await page.waitForSelector("#hex .b");
    const r = await page.evaluate(() => {
      const box = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height }; };
      return { list: box("#frame-region"), tree: box(".tree-col"), bytes: box("#panel-bytes"), exp: box("#export-finding"),
        scroll: document.scrollingElement.scrollHeight, iw: innerWidth, ih: innerHeight,
        rows: [...document.querySelectorAll("#frame-table tbody tr")].filter((t) => { const b = t.getBoundingClientRect(); const R = document.getElementById("frame-region").getBoundingClientRect(); return b.top >= R.top && b.bottom <= R.bottom; }).length };
    });
    assert.ok(r.scroll <= r.ih, `no page scrolling: ${r.scroll} > ${r.ih}`);
    for (const k of ["list", "tree", "bytes", "exp"]) {
      const b = r[k];
      assert.ok(b.top >= 0 && b.bottom <= r.ih && b.left >= 0 && b.right <= r.iw, `${k} inside the viewport: ${JSON.stringify(b)}`);
      assert.ok(b.h >= 40, `${k} is at least 40px tall (${Math.round(b.h)})`);
    }
    assert.ok(r.rows >= 4, `${r.rows} list rows visible`);
    console.log(`# analyzer ${width}x${height}: ${r.rows} rows visible, tree ${Math.round(r.tree.h)}px, bytes ${Math.round(r.bytes.h)}px, page ${r.scroll}px tall`);
    await page.close();
  });
}

test("route, title and H1 agree: Frames on wide screens, Frame details on narrow ones", async () => {
  for (const [width, title, h1, crumbs] of [[1440, "Frames – Mavframe", "Frames", ["Mavframe", "Frames"]], [375, "Frame details – Mavframe", "ATTITUDE at offset 13,866", ["Mavframe", "Frames", "Frame details"]]]) {
    const page = await openPage({ viewport: { width, height: 900 } });
    const href = await rowHref(page, 13866);
    await page.goto(base + href);
    await page.waitForSelector("#crc-compare .v");
    assert.equal(await page.title(), title, `${width}px title`);
    assert.equal(await h1Text(page), h1, `${width}px H1`);
    assert.deepEqual(await page.$$eval('nav[aria-label="Breadcrumb"] li', (l) => l.map((x) => x.textContent)), crumbs);
    await page.close();
  }
});

test("44 px targets: every interactive element on every screen at 320 and 1440 (and the check fails when shrunk)", async () => {
  for (const width of [320, 1440]) {
    const page = await openPage({ viewport: { width, height: 900 } });
    const href = await rowHref(page, 13866);
    const states = [["#/capture", null], ["#/frames", null], [href, null], ["#/help", null], ["#/nope", null]];
    if (width < 1000) states.push([href, "Bytes"], [href, "Header"], ["#/frames", "menu"]);
    let checked = 0;
    for (const [hash, extra] of states) {
      await page.goto(base + hash);
      await page.waitForFunction(() => [...document.querySelectorAll("h1")].some((h) => h.offsetParent !== null));
      if (hash.startsWith("#/frames")) await page.waitForFunction(() => [...document.querySelectorAll("#frame-table tbody tr, #detail-summary")].some((e) => e.offsetParent !== null));
      if (extra === "menu") await page.getByRole("button", { name: "Menu", exact: true }).click();
      else if (extra) await page.getByRole("tab", { name: extra }).click();
      await settle(page);
      assert.deepEqual(await smallTargets(page), [], `${hash} ${extra || ""} at ${width}px`);
      checked++;
      if (extra === "menu") await page.keyboard.press("Escape");
    }
    // Sabotage: shrinking nav links, tabs and Menu to 24px must be caught.
    await page.goto(base + (width < 1000 ? href : "#/frames"));
    await page.waitForFunction(() => [...document.querySelectorAll("h1")].some((h) => h.offsetParent !== null));
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('.nav a, [role="tab"], #menu-btn { min-height: 24px !important; height: 24px !important; padding-top: 0 !important; padding-bottom: 0 !important; }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    if (width < 1000) await page.getByRole("button", { name: "Menu", exact: true }).click();
    const caught = await smallTargets(page);
    const want = width < 1000 ? [/#menu-btn|"Menu"/, /"Capture"/, /tab-bytes|"Bytes"/] : [/"Capture"/, /"Frames"/, /"Format help"/];
    for (const re of want) assert.ok(caught.some((x) => re.test(x)), `sabotage at ${width}px caught ${re}: ${caught.join(" | ")}`);
    console.log(`# targets ${width}px: 0 under 44px on ${checked} screen states; sabotage caught ${caught.length}`);
    await page.close();
  }
});

test("320 px: the CRC status of each row is visible without sideways scrolling", async () => {
  const page = await openPage({ viewport: { width: 320, height: 800 } });
  await page.goto(base + "#/frames?check=crc");
  await page.waitForSelector("#frame-table tbody tr");
  const r = await page.$$eval("#frame-table tbody tr", (trs) => trs.map((tr) => { const b = tr.cells[0].getBoundingClientRect(); return [tr.cells[0].textContent.trim(), b.left >= 0 && b.right <= innerWidth]; }));
  assert.equal(r.length, 3);
  for (const [text, inside] of r) { assert.equal(text, "CRC failed"); assert.ok(inside, "CRC status cell inside the viewport"); }
  // Field tree words wrap at word boundaries only (no mid-word breaks).
  const href = await rowHref(page, 13866);
  await page.goto(base + href);
  await page.waitForSelector("#panel-decoded");
  const wrap = await page.$$eval("#detail .tree td:not(.mono)", (tds) => [...new Set(tds.map((t) => getComputedStyle(t).overflowWrap))]);
  assert.ok(!wrap.includes("anywhere"), `overflow-wrap ${wrap.join(",")}`);
  await page.close();
});

test("Frame details (375 px): ATTITUDE offset 13866 shows wire 0xA4FE vs computed 0x66D8, with Decoded/Bytes/Header tabs", async () => {
  const page = await openPage({ viewport: { width: 375, height: 800 } });
  const href = await rowHref(page, 13866);
  assert.match(href, /^#\/frames\/\d+(\?|$)/);
  await page.click(`#frame-table tbody tr[data-off="13866"] a`);
  await waitRoute(page, /^#\/frames\/\d+/);
  assert.equal(await page.title(), "Frame details – Mavframe");
  assert.equal(await focusedH1(page), "ATTITUDE at offset 13,866");
  const crc = await page.textContent("#crc-compare");
  assert.match(crc, /0xA4FE/);
  assert.match(crc, /0x66D8/);
  assert.match(await page.textContent("#detail-summary"), /CRC failed/);
  const tabs = await page.$$eval('[role="tab"]', (ts) => ts.map((t) => [t.textContent.trim(), t.getAttribute("aria-selected")]));
  assert.deepEqual(tabs.map((t) => t[0]), ["Decoded", "Bytes", "Header"]);
  // Arrow keys move between tabs (ARIA tabs pattern); the tab is kept in the URL.
  await page.getByRole("tab", { name: "Decoded" }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getAttribute('[role="tab"][aria-selected="true"]', "id"), "tab-bytes");
  await waitRoute(page, /tab=bytes/);
  assert.equal(await page.locator("#hex .seg-crc").count(), 2);
  await page.keyboard.press("ArrowRight");
  assert.match(await page.textContent("#panel-header"), /CRC\s*0xA4FE received, 0x66D8 computed/);
  // Global nav does not list an orphan Details item; the header has Back and a breadcrumb.
  assert.equal(await page.locator('nav[aria-label="Main"] a', { hasText: "details" }).count(), 0);
  assert.deepEqual(await page.$$eval('nav[aria-label="Breadcrumb"] li', (l) => l.map((x) => x.textContent)), ["Mavframe", "Frames", "Frame details"]);
  assert.equal(await page.isVisible("#back-link"), true);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("signed frames: 'signature present; not verified' stays visible in rows and details", async () => {
  const page = await openPage();
  const { default: os } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavframe-routes-"));
  assert.equal(spawnSync("python3", [path.join(DOCS, "..", "tests/web/gen_cases.py"), dir]).status, 0);
  await page.setInputFiles("#file", path.join(dir, "signed.tlog"));
  await waitParsed(page, "signed.tlog");
  await page.goto(base + "#/frames");
  await page.waitForSelector("#frame-table tbody tr");
  assert.match(await page.textContent("#frame-table tbody"), /signature present; not verified/);
  await page.locator("#frame-table tbody tr a").nth(2).click();
  await waitRoute(page, /^#\/frames\/2/);
  assert.match(await page.textContent("#detail"), /signature present; not verified/);
  assert.equal(await page.locator("#hex .seg-sig").count(), 13);
  fs.rmSync(dir, { recursive: true });
  await page.close();
});

test("finding export: JSON with version, file hash and CRCs, and no GPS/position payload by default", async () => {
  const page = await openPage({ acceptDownloads: true });
  for (const [off, name, hasPayload] of [[13866, "ATTITUDE", true], [34797, "GLOBAL_POSITION_INT", false]]) {
    const href = await rowHref(page, off);
    await page.goto(base + href);
    await page.waitForSelector("#export-finding");
    assert.equal(await page.isChecked("#include-payload"), false, "opt-in is off by default");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#export-finding")]);
    assert.match(dl.suggestedFilename(), /^mavframe-finding-.*\.json$/);
    const f = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
    assert.equal(f.finding.offset, off);
    assert.equal(f.finding.message.name, name);
    assert.equal(f.finding.crc.match, false);
    assert.match(f.file.sha256, /^[0-9a-f]{64}$/);
    assert.equal(f.file.size, truth.bytes);
    assert.equal("payload_hex" in f.bytes, hasPayload, `${name} payload exported: ${hasPayload}`);
    if (off === 13866) assert.deepEqual(f.finding.crc, { wire: "0xA4FE", computed: "0x66D8", match: false });
  }
  assert.match(await page.textContent("#export-status"), /Exported/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("gate 1: no page overflow at 320 and 768 px; 1440 fits; the table scrolls in its own region", async () => {
  for (const width of [320, 768, 1440]) {
    const page = await openPage({ viewport: { width, height: 900 } });
    for (const hash of await screenHashes(page)) {
      await page.goto(base + hash);
      await page.waitForFunction(() => [...document.querySelectorAll("h1")].some((h) => h.offsetParent !== null));
      if (hash.startsWith("#/frames")) await page.waitForFunction(() => [...document.querySelectorAll("#frame-table tbody tr, #detail-summary")].some((e) => e.offsetParent !== null));
      const r = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, w: window.innerWidth }));
      assert.ok(r.sw <= r.w, `${hash} at ${width}px: page ${r.sw}px wide in ${r.w}px`);
    }
    await page.close();
  }
});

test("gate 2: the mobile Menu opens a sheet, keeps focus inside, closes with Escape and returns focus", async () => {
  for (const width of [320, 768]) {
    const page = await openPage({ viewport: { width, height: 800 } });
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    assert.equal(await menu.isVisible(), true, `Menu visible at ${width}px`);
    assert.equal(await page.isVisible('nav[aria-label="Main"]'), false, "no permanent rail");
    assert.equal(await menu.getAttribute("aria-expanded"), "false");
    await menu.click();
    assert.equal(await menu.getAttribute("aria-expanded"), "true");
    assert.equal(await page.isVisible('nav[aria-label="Main"]'), true);
    const inSheet = () => page.evaluate(() => !!document.activeElement.closest("#sheet"));
    assert.ok(await inSheet(), "focus moved into the sheet");
    for (let i = 0; i < 12; i++) { await page.keyboard.press("Tab"); assert.ok(await inSheet(), `Tab ${i} stays in the sheet`); }
    for (let i = 0; i < 12; i++) { await page.keyboard.press("Shift+Tab"); assert.ok(await inSheet(), `Shift+Tab ${i} stays in the sheet`); }
    await page.keyboard.press("Escape");
    assert.equal(await page.isVisible('nav[aria-label="Main"]'), false, "closed");
    assert.equal(await page.evaluate(() => document.activeElement.id), "menu-btn", "focus back on Menu");
    // Choosing a destination closes the sheet and focuses the new screen's H1.
    await menu.click();
    await page.getByRole("link", { name: "Format help" }).click();
    await waitRoute(page, /^#\/help/);
    assert.equal(await focusedH1(page), "Format help");
    assert.equal(await menu.getAttribute("aria-expanded"), "false");
    await page.close();
  }
  // Desktop: the 216 px rail is permanent and the Menu button is not shown.
  const page = await openPage({ viewport: { width: 1440, height: 900 } });
  assert.equal(await page.isVisible("#menu-btn"), false);
  const rail = await page.$eval("#sheet", (e) => Math.round(e.getBoundingClientRect().width));
  assert.equal(rail, 216);
  await page.close();
});

test("gate 3: every route change moves focus to the H1 and sets the title", async () => {
  const page = await openPage();
  for (const [link, h1, title] of [["Frames", "Frames", "Frames – Mavframe"], ["Format help", "Format help", "Format help – Mavframe"], ["Capture", "Capture", "Capture – Mavframe"]]) {
    await page.locator('nav[aria-label="Main"]').getByRole("link", { name: link, exact: true }).click();
    await page.waitForFunction((t) => document.title === t, title);
    assert.equal(await focusedH1(page), h1);
    assert.equal(await page.locator('nav[aria-label="Main"] a[aria-current="page"]').textContent(), link);
    // The H1 shows no focus outline across the workspace (only the heading is focused).
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("tabindex")), "-1");
  }
  await page.goto(base + "#/no-such-screen");
  await page.waitForFunction(() => document.title === "Not found – Mavframe");
  assert.equal(await focusedH1(page), "Not found");
  await page.getByRole("link", { name: "Go to Capture" }).click();
  await page.waitForFunction(() => document.title === "Capture – Mavframe");
  await page.close();
});

for (const width of [375, 1440]) {
  test(`gate 4: Back/Forward and deep links restore screen and state; old links still work (${width} px)`, async () => {
    const narrow = width < 1000;
    const viewport = { width, height: 900 };
    const page = await openPage({ hash: "#/frames", viewport });
    await page.getByRole("button", { name: "CRC failed", exact: true }).click();
    await page.selectOption("#msg-filter", "30");
    await waitRoute(page, /check=crc.*msg=30|msg=30.*check=crc/);
    await page.locator("#frame-table tbody tr a").first().click();
    await waitRoute(page, /^#\/frames\/\d+/);
    if (narrow) await page.getByRole("tab", { name: "Header" }).click();
    else await page.locator("#panel-header").getByRole("button", { name: "CRC", exact: true }).click();
    await waitRoute(page, narrow ? /tab=header/ : /f=crc/);
    const detailUrl = page.url();
    await page.goBack();
    await waitRoute(page, /^#\/frames\?/);
    await page.waitForFunction(() => document.title === "Frames – Mavframe");
    assert.equal(await page.getAttribute('[data-check="crc"]', "aria-pressed"), "true", "check filter restored");
    assert.equal(await page.inputValue("#msg-filter"), "30", "message filter restored");
    assert.equal(await page.locator("#frame-table tbody tr").count(), 1);
    assert.equal(await focusedH1(page), "Frames");
    await page.goForward();
    await waitRoute(page, /^#\/frames\/\d+/);
    if (narrow) assert.equal(await page.getAttribute("#tab-header", "aria-selected"), "true", "tab restored");
    else assert.equal(await page.locator("#hex .b.hl").count(), 2, "selected field restored");
    // The header Back link (narrow Frame details) returns to the filtered list too.
    if (narrow) {
      await page.click("#back-link");
      await page.waitForFunction(() => document.title === "Frames – Mavframe");
      assert.equal(await page.getAttribute('[data-check="crc"]', "aria-pressed"), "true");
    }
    // Deep link straight into details in a new tab.
    const p2 = await openPage({ hash: detailUrl.slice(detailUrl.indexOf("#")), viewport });
    await p2.waitForSelector("#crc-compare");
    assert.match(await p2.textContent("#crc-compare"), /0xA4FE.*0x66D8/s);
    if (narrow) assert.equal(await p2.getAttribute("#tab-header", "aria-selected"), "true");
    // Links from the old single-page inspector map to the new routes.
    const p3 = await openPage({ hash: "#view=issues&sel=i0", viewport });
    await p3.waitForFunction(() => /^#\/frames\/\d+/.test(location.hash));
    assert.match(await p3.textContent("#crc-compare"), /0xA4FE/);
    const p4 = await openPage({ hash: "#view=frames&msg=30", viewport });
    await p4.waitForFunction(() => /^#\/frames\?/.test(location.hash));
    assert.equal(await p4.inputValue("#msg-filter"), "30");
    assert.deepEqual([...page.errors, ...p2.errors, ...p3.errors, ...p4.errors], []);
    for (const p of [page, p2, p3, p4]) await p.close();
  });
}

for (const [theme, width] of [["light", 1280], ["dark", 1280], ["light", 320], ["dark", 320]]) {
  test(`gate 5: axe-core 0 violations on every primary screen (${theme}, ${width} px)`, async () => {
    const page = await openPage({ viewport: { width, height: 900 } });
    if (theme === "dark") {
      if (width < 1000) await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page.getByRole("button", { name: "Dark theme" }).click();
      if (width < 1000) await page.keyboard.press("Escape");
      assert.equal(await page.getAttribute("html", "data-theme"), "dark");
    }
    let passes = 0;
    for (const hash of await screenHashes(page)) {
      await page.goto(base + hash);
      await page.waitForFunction(() => [...document.querySelectorAll("h1")].some((h) => h.offsetParent !== null));
      if (hash === "#/frames") await page.waitForSelector("#frame-table tbody tr");
      const tabs = hash.startsWith("#/frames/") && width < 1000 ? ["Decoded", "Bytes", "Header"] : [null];
      for (const tab of tabs) {
        if (tab) await page.getByRole("tab", { name: tab }).click();
        const a = await axeViolations(page);
        assert.deepEqual(a.violations, [], `${hash}${tab ? " " + tab : ""} (${theme}, ${width}px)`);
        passes += a.passes;
      }
    }
    if (width < 1000) {
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      const a = await axeViolations(page);
      assert.deepEqual(a.violations, [], `menu sheet open (${theme}, ${width}px)`);
    }
    assert.deepEqual(await cspViolations(page), []);
    console.log(`# axe ${theme} ${width}px: 0 violations on 4 screens${width < 1000 ? " (+ Bytes and Header tabs, menu sheet)" : ""}, ${passes} rule passes`);
    await page.close();
  });
}

test("gate 6: light is the default even when the OS prefers dark; dark is an explicit, remembered choice", async () => {
  const page = await openPage({ colorScheme: "dark" });
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(await bg(), "rgb(247, 248, 250)", "canvas #f7f8fa under OS dark");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".workspace-header")).backgroundColor), "rgb(255, 255, 255)");
  const toggle = page.getByRole("button", { name: "Dark theme" });
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  assert.notEqual(await bg(), "rgb(247, 248, 250)");
  await page.reload();
  await waitParsed(page, "sample-flight.tlog");
  assert.equal(await page.getAttribute("html", "data-theme"), "dark", "choice remembered");
  await page.getByRole("button", { name: "Dark theme" }).click();
  assert.equal(await bg(), "rgb(247, 248, 250)");
  // Blocked storage: still light, no errors.
  const blocked = await openPage({ colorScheme: "dark", route: (p) => p.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
  }) });
  assert.equal(await blocked.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(247, 248, 250)");
  await blocked.getByRole("button", { name: "Dark theme" }).click();
  assert.deepEqual(blocked.errors, []);
  await blocked.close();
  await page.close();
});

test("gate 7: no console errors or CSP violations across all routes; primary colour is #005a9c", async () => {
  const page = await openPage();
  for (const hash of await screenHashes(page)) {
    await page.goto(base + hash);
    await settle(page);
  }
  const primary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--primary").trim());
  assert.equal(primary.toLowerCase(), "#005a9c");
  assert.deepEqual(await cspViolations(page), []);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("screenshots for the README (light, 2x, real sample)", { skip: !process.env.SCREENSHOT }, async () => {
  fs.mkdirSync(path.join(DOCS, "screenshots"), { recursive: true });
  for (const [width, height] of [[1440, 900], [320, 900]]) {
    const page = await openPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    await page.goto(base + "#/frames");
    await page.waitForSelector("#frame-table tbody tr");
    await page.evaluate(() => document.activeElement.blur());
    await settle(page);
    await page.screenshot({ path: path.join(DOCS, "screenshots", `frames-${width}.png`) });
    if (width === 1440) {
      const href = await rowHref(page, 13866);
      await page.goto(base + href);
      await page.waitForSelector("#crc-compare");
      await page.locator("#panel-header").getByRole("button", { name: "CRC", exact: true }).click();
      await page.evaluate(() => document.activeElement.blur());
      await settle(page);
      await page.screenshot({ path: path.join(DOCS, "screenshots", "frame-details-1440.png") });
    }
    await page.close();
  }
});
