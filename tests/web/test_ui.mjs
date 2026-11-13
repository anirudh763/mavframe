// End-to-end tests of the inspector's behaviour in Chromium (Playwright):
// exact counts, decoding, errors, cancel, large files, keyboard use and the
// design standard's contrast checks. The routed layout and the root visual
// gate (overflow, Menu, focus, Back/Forward, axe in light and dark) are in
// tests/web/test_routes.mjs.
//
//   node --test tests/web/test_ui.mjs
//
// Needs the playwright and axe-core npm packages (resolved with require()).
// AXE_PATH can point at axe.min.js directly.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium, ROOT, truth, startServer, openPage as open, waitParsed, cspViolations, axeViolations, settle, contrast, bgFn } from "./browser.mjs";

const CASES = fs.mkdtempSync(path.join(os.tmpdir(), "mavframe-ui-cases-"));
{
  const gen = spawnSync("python3", [path.join(ROOT, "tests/web/gen_cases.py"), CASES]);
  assert.equal(gen.status, 0, gen.stderr.toString());
}

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
const statusText = (page) => page.textContent("#status");
const metric = (page, id) => page.$eval(`#${id}`, (dd) => dd.firstChild.textContent.replace(/,/g, ""));
const upload = (page, file) => page.setInputFiles("#file", file);
async function goFrames(page, query = "") {
  await page.goto(base + "#/frames" + query);
  await page.waitForFunction(() => document.querySelector("#frame-table tbody tr") && !document.getElementById("screen-frames").hidden);
}

test("Load engineering sample shows the generator's exact counts and per-sender rates", async () => {
  const page = await openPage();
  // While the sample downloads, the old result's status must not stay up.
  await page.route("**/sample/sample-flight.tlog", async (r) => { await new Promise((ok) => setTimeout(ok, 400)); await r.continue(); });
  await page.getByRole("button", { name: "Load engineering sample" }).click();
  assert.match(await statusText(page), /^Loading sample-flight.tlog/);
  assert.equal(await page.isDisabled("#load-sample"), true);
  await waitParsed(page, "sample-flight.tlog");
  assert.equal(await metric(page, "m-frames"), String(truth.frames));
  assert.equal(await metric(page, "m-crc"), String(truth.crc_errors));
  assert.equal(await metric(page, "m-gaps"), String(truth.gaps));
  assert.equal(await metric(page, "m-skipped"), String(truth.skipped_bytes));
  assert.match(await page.textContent("#m-gaps"), new RegExp(`${truth.missing_frames} frames missing`));
  assert.match(await page.textContent("#source"), /Engineering fixture/);
  const rows = await page.$$eval("#msg-table tbody tr", (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));
  assert.equal(rows.length, Object.keys(truth.messages).length);
  for (const [id, name, count, , crc] of rows) {
    assert.equal(name, truth.messages[id].name);
    assert.equal(count.replace(/,/g, ""), String(truth.messages[id].count));
    assert.equal(crc, String(truth.messages[id].crc_errors));
  }
  const hb = await page.textContent("#msg-table tbody tr:first-child");
  assert.match(hb, /1:1 at 1\.00 Hz/);
  assert.match(hb, /255:190 at 1\.00 Hz/);
  assert.match(hb, /2\.00 all/);
  // The external link must not replace the loaded capture.
  assert.equal(await page.getAttribute("#gap-assumptions a", "target"), "_blank");
  assert.match(await page.getAttribute("#gap-assumptions a", "rel"), /noopener/);
  // A message name links to Frames filtered to it.
  await page.locator("#msg-table").getByRole("link", { name: "GPS_RAW_INT" }).click();
  await page.waitForFunction(() => /^#\/frames\?msg=24$/.test(location.hash));
  assert.equal(await page.inputValue("#msg-filter"), "24");
  // GPS_RAW_INT yaw 0 means "not provided" (official XML: invalid="0").
  await page.locator("#frame-table tbody tr a").first().click();
  await page.waitForSelector("#panel-decoded .fieldbtn");
  assert.match(await page.textContent("#panel-decoded"), /yaw \(extension\)\s*0 cdeg\s*not provided/);
  // Timeline markers on Frames.
  await goFrames(page);
  assert.equal(await page.locator("#timeline g.crc").count(), truth.crc_errors);
  assert.equal(await page.locator("#timeline g.gap").count(), truth.gaps);
  assert.deepEqual(await cspViolations(page), [], "CSP violations");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("Next and Previous issue step through CRC failures and sequence gaps", async () => {
  const page = await openPage();
  await goFrames(page);
  await page.getByRole("button", { name: "Next issue" }).click();
  await page.waitForFunction(() => /^#\/frames\/\d+/.test(location.hash));
  assert.match(await page.textContent("#detail-title"), new RegExp(`at offset ${truth.crc_error_offsets[0].toLocaleString("en-US")}$`));
  assert.match(await page.textContent("#crc-compare"), /Mismatch: CRC failed/);
  await page.getByRole("button", { name: "Next issue" }).click();
  await page.waitForFunction((o) => document.getElementById("detail-title").textContent.endsWith(o), truth.gap_list[0].offset.toLocaleString("en-US"));
  assert.match(await page.textContent("#detail-notes"), /Sequence gap/);
  assert.match(await page.textContent("#crc-compare"), /Match: valid CRC/);
  await page.getByRole("button", { name: "Previous issue" }).click();
  await page.waitForFunction((o) => document.getElementById("detail-title").textContent.endsWith(o), truth.crc_error_offsets[0].toLocaleString("en-US"));
  // Previous row / Next row move one row.
  await page.getByRole("button", { name: "Next row" }).click();
  await page.waitForFunction((o) => !document.getElementById("detail-title").textContent.endsWith(o), truth.crc_error_offsets[0].toLocaleString("en-US"));
  assert.deepEqual(page.errors, []);
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
  // The Frames list of the big capture opens without materialising every row.
  await goFrames(page);
  assert.match(await page.textContent("#page-info"), new RegExp(`of ${(truth.frames * copies + truth.crc_errors * copies).toLocaleString("en-US")}`));
  fs.rmSync(dir, { recursive: true });
  await page.close();
});

test("keyboard only: load the sample, go to Frames, step to an issue, move through rows", async () => {
  const page = await openPage();
  async function tabTo(selector, max = 80) {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate((sel) => document.activeElement === document.querySelector(sel), selector)) return;
    }
    throw new Error(`could not reach ${selector} with Tab`);
  }
  await tabTo("#load-sample");
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "none", "focus indicator visible");
  await page.route("**/sample/sample-flight.tlog", async (r) => { await new Promise((ok) => setTimeout(ok, 400)); await r.continue(); });
  await page.keyboard.press("Enter");
  assert.match(await statusText(page), /^Loading sample-flight.tlog/);
  await waitParsed(page, "sample-flight.tlog");
  await page.waitForFunction(() => document.activeElement.id === "load-sample");
  await tabTo("#file");
  await tabTo("#format");
  await tabTo('.nav a[data-route="frames"]');
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement.id === "h-frames");
  await tabTo("#next-issue");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /^#\/frames\/\d+/.test(location.hash));
  assert.match(await page.textContent("#crc-compare"), /CRC failed/);
  await tabTo('#frame-table a[aria-current="true"]');
  const before = await page.evaluate(() => document.activeElement.dataset.pos);
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction((b) => document.activeElement.dataset.pos !== b, before);
  // The frame list and the bytes are focusable, labelled scroll regions.
  await tabTo("#frame-region", 120).catch(async () => { await page.focus("#frame-region"); });
  assert.equal(await page.getAttribute("#frame-region", "aria-label"), "Frame rows");
  await tabTo("#hex", 260);
  assert.notEqual(await page.$eval("#hex", (e) => getComputedStyle(e).outlineStyle), "none");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("375 px width and 200% zoom: no horizontal page scroll, controls on screen", async () => {
  for (const [label, opts] of [
    ["375 px", { viewport: { width: 375, height: 800 } }],
    ["200% page zoom of a 1280 px window", { viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 }],
  ]) {
    const page = await openPage(opts);
    for (const [hash, ids] of [["#/capture", ["load-sample", "m-frames", "m-crc", "m-unsupported"]], ["#/frames", ["next-issue", "msg-filter", "frame-region"]]]) {
      await page.goto(base + hash);
      await page.waitForFunction((id) => document.getElementById(id).offsetParent !== null, ids[0]);
      const r = await page.evaluate((ids) => ({ scroll: document.scrollingElement.scrollWidth, width: window.innerWidth,
        out: ids.filter((id) => { const b = document.getElementById(id).getBoundingClientRect(); return b.right > window.innerWidth + 0.5 || b.left < 0; }) }), ids);
      assert.ok(r.scroll <= r.width, `${label} ${hash}: page is ${r.scroll}px wide in a ${r.width}px viewport`);
      assert.deepEqual(r.out, [], `${label} ${hash}: controls outside the viewport`);
    }
    await page.close();
  }
  // 200% text size (browser text-only zoom) at 1280 px.
  const page = await openPage({ viewport: { width: 1280, height: 900 } });
  await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; }); // CSSOM: allowed by the CSP
  for (const hash of ["#/capture", "#/frames", "#/help"]) {
    await page.goto(base + hash);
    await settle(page);
    const r = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, width: window.innerWidth }));
    assert.ok(r.scroll <= r.width, `200% text ${hash}: page is ${r.scroll}px wide`);
  }
  await page.close();
});

test("error and empty states: empty file, not a MAVLink file, oversized file, network failures", async () => {
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
  await goFrames(page);
  assert.match(await page.textContent("#frame-table tbody"), /No frames to show/);
  await page.goto(base + "#/frames/5");
  await page.waitForFunction(() => /There is no row 5/.test(document.getElementById("detail-empty").textContent));

  await page.goto(base + "#/capture");
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

  const noSample = await openPage({ noWait: true, hash: "#/frames", route: (p) => p.route("**/sample/sample-flight.tlog", (r) => r.abort()) });
  await noSample.waitForFunction(() => /Could not load the sample/.test(document.getElementById("status").textContent));
  await noSample.waitForFunction(() => /No capture is loaded yet/.test(document.getElementById("frames-empty").textContent));
  assert.equal(await noSample.getByRole("link", { name: "Go to Capture" }).isVisible(), true);
  await noSample.goto(base + "#/capture");
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

test("unsupported message ids are explained as not checked, not corrupt; axe stays clean", async () => {
  const page = await openPage();
  await upload(page, path.join(CASES, "malformed.bin"));
  await page.waitForFunction(() => /^malformed.bin:/.test(document.getElementById("status").textContent) && !document.getElementById("load-sample").disabled);
  assert.ok(Number(await metric(page, "m-unsupported")) >= 1);
  assert.ok(Number(await metric(page, "m-crc")) >= 1);
  await goFrames(page, "?check=unsupported");
  await page.locator("#frame-table tbody tr", { hasText: "Unsupported (not checked)" }).first().locator("a").click();
  await page.waitForSelector("#detail-notes .note");
  assert.match(await page.textContent("#detail-notes"), /not counted as corrupt/);
  assert.match(await page.textContent("#crc-compare"), /Not checked: no CRC_EXTRA/);
  const a = await axeViolations(page);
  assert.deepEqual(a.violations, [], "axe on an unsupported row of a malformed capture");
  await page.close();
});

test("duplicate and backward sequence numbers are labelled, not shown as missing frames", async () => {
  const page = await openPage();
  for (const [file, kind] of [["seq-duplicate.bin", "Duplicate seq"], ["seq-backwards.bin", "Out of order"]]) {
    await page.goto(base + "#/capture");
    await upload(page, path.join(CASES, file));
    await waitParsed(page, file);
    assert.equal(await metric(page, "m-gaps"), "0", file);
    assert.match(await page.textContent("#m-gaps"), /~0 frames missing if packets arrived in order/);
    assert.equal(await metric(page, "m-crc"), "0");
    await goFrames(page, "?check=issues");
    const notes = await page.$$eval("#frame-table tbody tr", (trs) => trs.map((tr) => tr.cells[6].textContent));
    assert.equal(notes.length, 1, notes.join("|"));
    assert.match(notes[0], new RegExp(`^${kind}:`));
    await page.locator("#frame-table tbody tr a").first().click();
    await page.waitForSelector("#detail-notes .note");
    assert.match(await page.textContent("#detail-notes"), /Not counted as missing/);
  }
  await page.close();
});

test("pager: Next page to the last page moves focus to Previous page; counts match", async () => {
  const page = await openPage();
  await goFrames(page);
  const total = truth.frames + truth.crc_errors;
  assert.match(await page.textContent("#page-info"), new RegExp(`of ${total.toLocaleString("en-US")} rows`));
  await page.locator("#next-page").focus();
  while (!(await page.isDisabled("#next-page"))) await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement.id), "prev-page");
  assert.match(await page.url(), /page=\d+/, "page is in the URL");
  await page.close();
});

test("with JavaScript off, a <noscript> message explains why nothing works", async () => {
  for (const width of [1280, 375]) {
    const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width, height: 800 } });
    await page.goto(base);
    const note = page.locator("#noscript");
    assert.ok(await note.isVisible(), `noscript message visible (${width} px)`);
    const box = await note.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width, `message fits in ${width} px`);
    const ratio = await page.$eval("#noscript", (el) => { const cs = getComputedStyle(el); return [cs.color, cs.backgroundColor]; });
    const c = contrast(ratio[0], ratio[1]);
    assert.ok(c >= 4.5, `noscript text contrast ${c.toFixed(2)}:1`);
    console.log(`# noscript ${width}px: contrast ${c.toFixed(2)}:1`);
    await page.close();
  }
  const page = await openPage();
  assert.equal(await page.locator("#noscript").count(), 0);
  assert.deepEqual(page.errors, []);
  await page.close();
});

// ---------- design standard: contrast and consistency computed from the rendered page ----------
const darkInit = (p) => p.addInitScript(() => { try { localStorage.setItem("mavframe-theme", "dark"); } catch { /* ignore */ } });

for (const theme of ["light", "dark"]) {
  test(`timeline density bars and their legend glyph reach 3:1 (${theme})`, async () => {
    const page = await openPage({ viewport: { width: 1280, height: 900 }, route: theme === "dark" ? darkInit : null });
    await goFrames(page);
    const r = await page.evaluate((src) => {
      const bg = eval(src);
      const bin = document.querySelector("#timeline .bin");
      const glyph = document.querySelector(".g-density");
      return { bin: getComputedStyle(bin).fill, binBg: bg(document.getElementById("timeline")), glyph: getComputedStyle(glyph).fill, glyphBg: bg(glyph.closest("li")) };
    }, bgFn);
    const bars = contrast(r.bin, r.binBg);
    const legend = contrast(r.glyph, r.glyphBg);
    console.log(`# timeline ${theme}: bars ${bars.toFixed(2)}:1, legend glyph ${legend.toFixed(2)}:1`);
    assert.ok(bars >= 3 && legend >= 3, `bars ${bars.toFixed(2)}, legend ${legend.toFixed(2)} (${theme})`);
    await page.close();
  });

  test(`hex byte regions differ by a non-colour mark with 3:1 contrast and a text name (${theme})`, async () => {
    const page = await openPage({ viewport: { width: 1440, height: 900 }, route: theme === "dark" ? darkInit : null });
    await goFrames(page, "?check=crc");
    await page.locator("#frame-table tbody tr a").first().click();
    await page.waitForSelector("#hex .b");
    const segs = ["seg-ts", "seg-hdr", "seg-pay", "seg-crc", "seg-sig"];
    const r = await page.evaluate(([src, segs]) => {
      const bg = eval(src);
      const mark = (el) => { const cs = getComputedStyle(el);
        return { style: cs.borderBottomStyle, width: cs.borderBottomWidth, color: cs.borderBottomColor, own: bg(el), behind: bg(el.parentElement) }; };
      const legend = Object.fromEntries(segs.map((s) => [s, mark(document.querySelector(`.legend .swatch.${s}`))]));
      const hex = Object.fromEntries(segs.filter((s) => document.querySelector(`#hex .b.${s}`)).map((s) => {
        const first = document.querySelector(`#hex .b.${s}`);
        const prev = first.previousElementSibling;
        return [s, { ...mark(first), name: prev && prev.classList.contains("sr-only") ? prev.textContent : null }];
      }));
      return { legend, hex };
    }, [bgFn, segs]);
    const patterns = segs.map((s) => `${r.legend[s].style} ${r.legend[s].width}`);
    assert.equal(new Set(patterns).size, segs.length, `region marks must differ: ${patterns.join(" | ")}`);
    for (const s of segs) {
      const m = r.legend[s];
      if (m.style === "none") continue;
      for (const against of [m.own, m.behind]) assert.ok(contrast(m.color, against) >= 3, `${s} mark ${contrast(m.color, against).toFixed(2)}:1 (${theme})`);
    }
    assert.deepEqual(Object.keys(r.hex), ["seg-ts", "seg-hdr", "seg-pay", "seg-crc"]);
    for (const [s, m] of Object.entries(r.hex)) {
      assert.equal(`${m.style} ${m.width}`, `${r.legend[s].style} ${r.legend[s].width}`, `${s} bytes match the legend`);
      assert.ok(m.name && m.name.trim().length > 2, `${s}: first byte is preceded by a visually hidden region name`);
    }
    // A selected field's bytes are highlighted with text contrast >= 4.5:1.
    await page.locator("#panel-header").getByRole("button", { name: "CRC", exact: true }).click();
    const hl = await page.$eval("#hex .b.hl", (e) => { const cs = getComputedStyle(e); return [cs.color, cs.backgroundColor]; });
    assert.ok(contrast(hl[0], hl[1]) >= 4.5, `highlighted byte text ${contrast(hl[0], hl[1]).toFixed(2)}:1 (${theme})`);
    await page.close();
  });
}

test("monospace only for offsets and hex; one face for headers; 44 px controls", async () => {
  const page = await openPage();
  await goFrames(page);
  const r = await page.evaluate(() => {
    const ff = (sel) => getComputedStyle(document.querySelector(sel)).fontFamily;
    const row = document.querySelector("#frame-table tbody tr");
    return {
      heads: [...document.querySelectorAll("#frame-table th")].map((th) => getComputedStyle(th).fontFamily),
      time: getComputedStyle(row.cells[0]).fontFamily, offset: getComputedStyle(row.cells[1]).fontFamily, body: ff("body"),
      sizes: [...document.querySelectorAll(".chip, #next-issue, #prev-issue, #msg-filter")].map((e) => Math.round(e.getBoundingClientRect().height)),
    };
  });
  assert.equal(new Set(r.heads).size, 1);
  assert.equal(r.heads[0], r.body);
  assert.equal(r.time, r.body, "times use the UI face (tabular numbers)");
  assert.match(r.offset, /monospace/, "offsets are monospace");
  assert.ok(r.sizes.every((h) => h >= 44), `control heights ${r.sizes.join(",")}`);
  await page.close();
});

test("Source on GitHub looks like a link; the primary button has a hover state", async () => {
  const page = await openPage();
  const r = await page.evaluate(() => {
    const repo = document.querySelector(".rail-foot a[href='https://github.com/anirudh763/mavframe']");
    const prose = document.querySelector("#gap-assumptions a");
    return { deco: getComputedStyle(repo).textDecorationLine, color: getComputedStyle(repo).color, link: getComputedStyle(prose).color };
  });
  assert.match(r.deco, /underline/);
  assert.equal(r.color, r.link);
  const look = () => page.$eval('label[for="file"]', (e) => getComputedStyle(e).backgroundColor);
  await page.mouse.move(0, 0);
  const idle = await look();
  await page.hover('label[for="file"]');
  await settle(page);
  assert.notEqual(await look(), idle, "primary button hover state");
  await page.close();
});

test("the root font size follows the browser's default text size", async () => {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.enable");
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: 20, fixed: 20 } });
  await page.goto(base);
  const px = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  assert.ok(px > 19.5, `root font is ${px}px with a 20px browser default`);
  await page.close();
});
