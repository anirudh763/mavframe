// Shared Playwright harness for the browser tests: a static server over docs/,
// one Chromium, page helpers, axe-core and colour maths.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const { chromium } = require("playwright");
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DOCS = path.join(ROOT, "docs");
export const truth = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/web/sample-truth.json"), "utf8"));
const AXE = process.env.AXE_PATH || require.resolve("axe-core/axe.min.js");
// axe is evaluated through the DevTools protocol, not injected as a <script>, so the CSP stays on.
export const AXE_SOURCE = fs.readFileSync(AXE, "utf8");
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm",
  ".woff2": "font/woff2", ".tlog": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain" };

export async function startServer() {
  const server = http.createServer((req, res) => {
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
  return { server, base: `http://127.0.0.1:${server.address().port}/` };
}

export function waitParsed(page, name, timeout = 30000) {
  return page.waitForFunction((n) => {
    const s = document.getElementById("status").textContent;
    return s.startsWith(n + ":") && /valid frames/.test(s) && !document.getElementById("load-sample").disabled;
  }, name, { timeout });
}

// Open the page with error and CSP-violation recording. opts: hash, route, noWait, plus newPage options.
export async function openPage(browser, base, opts = {}) {
  const { hash, route, noWait, ...ctx } = opts;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ...ctx });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.errors = errors;
  page.setDefaultTimeout(15000);
  if (route) await route(page);
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto(base + (hash || ""));
  if (!noWait) await waitParsed(page, "sample-flight.tlog");
  return page;
}

export const cspViolations = (page) => page.evaluate(() => window.__csp);

// Wait until no CSS transition or animation is running (a replaced transition rejects
// its `finished` promise with AbortError, hence allSettled in a loop).
export const settle = (page) => page.evaluate(async () => {
  for (let anims; (anims = document.getAnimations()).length;) await Promise.allSettled(anims.map((x) => x.finished));
});

export async function axeViolations(page) {
  if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(AXE_SOURCE);
  await settle(page);
  return page.evaluate(async (tags) => {
    const r = await window.axe.run(document, { runOnly: tags });
    return { passes: r.passes.length, violations: r.violations.map((v) => `${v.id}: ${v.nodes.length} (${v.nodes[0].target.join(" ")})`) };
  }, AXE_TAGS);
}

const rgbOf = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
const lumOf = (c) => rgbOf(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
  .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
export const contrast = (a, b) => { const [x, y] = [lumOf(a), lumOf(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// The colour actually painted behind an element: the nearest ancestor-or-self with an opaque background.
export const bgFn = `(el) => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor;
  if (!/rgba\\(.*, 0\\)$/.test(c) && c !== "transparent") return c; } return "rgb(255, 255, 255)"; }`;

// Interactive elements whose target is smaller than 44 x 44 CSS px. An input's target is its
// label when it has one (the label is the click area; the file input itself is visually hidden).
// Links inside running text are exempt (WCAG 2.5.8 "inline" exception); the off-screen skip link
// is checked only when focused.
export const smallTargets = (page) => page.evaluate(() => {
  const out = [];
  const sel = 'a[href], button, select, input, [role="tab"], [tabindex="0"]';
  for (const el of document.querySelectorAll(sel)) {
    if (el.classList.contains("skip")) continue;
    let box = el.getBoundingClientRect();
    if (el.matches("input")) {
      const label = el.closest("label") || (el.id && document.querySelector(`label[for="${el.id}"]`));
      if (label) box = label.getBoundingClientRect();
    }
    if (box.width === 0 && box.height === 0) continue; // not rendered (hidden screen, closed sheet)
    if (getComputedStyle(el).visibility === "hidden") continue;
    if (el.tagName === "A" && getComputedStyle(el).display === "inline") {
      const p = el.parentElement;
      if (p && p.textContent.trim().length > el.textContent.trim().length) continue;
    }
    if (box.height < 43.5 || box.width < 43.5) {
      out.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""} "${(el.getAttribute("aria-label") || el.textContent).trim().slice(0, 24)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
  }
  return out;
});
