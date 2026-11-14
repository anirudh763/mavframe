// UI for the mavframe inspector: hash routes, the packet analyzer (frame list |
// field tree | bytes) and the finding export. Analysis lives in core.js (the
// C parser in WebAssembly), rows.js and anatomy.js; this file only renders.
// Everything taken from a capture is inserted with textContent.
import { loadParser, analyze, MAX_CAPTURE_BYTES } from "./core.js";
import { rowIndex, rowInfo, filterRows, issuePositions, CANDIDATE_KINDS } from "./rows.js";
import { anatomy, hexN, msgLabel } from "./anatomy.js";
import { buildFinding } from "./finding.js";

const SAMPLE = { url: "sample/sample-flight.tlog", name: "sample-flight.tlog" };
const PAGE = 100;
// The three-pane analyzer needs room for the list, the header fields (8 rows of 44px targets) and
// 8+ rows of bytes at once; below this size Frames -> Frame details is a two-step route.
const WIDE = window.matchMedia("(min-width: 1200px) and (min-height: 880px)");
const CHECKS = ["all", "issues", "crc", "unsupported", "valid"];
const TABS = ["decoded", "bytes", "header"];
const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("en-US");

const state = {
  parser: null, result: null, bytes: null, name: "", isSample: false, busy: false, abort: null,
  rowsKey: "", rows: null, lastScreen: null, lastHash: null, prevRoute: null, route: null, keepFocusNext: false,
};

// ---------- DOM helpers ----------
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : String(c));
  return e;
}
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};
const hex2 = (b) => b.toString(16).padStart(2, "0");

function setStatus(text, isError = false) {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("error", isError);
}

// Hand control back to the browser between chunks without the 4 ms clamp of setTimeout.
const channel = new MessageChannel();
const waiting = [];
channel.port1.onmessage = () => waiting.shift()?.();
function yieldToBrowser() {
  return new Promise((resolve) => { waiting.push(resolve); channel.port2.postMessage(0); });
}

const timeMode = () => state.result && !Number.isNaN(state.result.firstTs) && state.result.endTs > state.result.firstTs;
function relTime(ts) {
  const r = state.result;
  if (!r || Number.isNaN(ts) || Number.isNaN(r.firstTs)) return "";
  return ((ts - r.firstTs) / 1e6).toFixed(3);
}

// ---------- routes ----------
// #/capture | #/frames?check=&msg=&page= | #/frames/<index>?check=&msg=&tab=&f= | #/help
function parseHash(hash) {
  if (!hash || hash === "#" || hash === "#/") return { screen: "capture", params: {} };
  if (/^#(view|msg|sel)=/.test(hash)) return { screen: "legacy", params: {} };
  if (!hash.startsWith("#/")) return { screen: "anchor", params: {} };
  const [path, query = ""] = hash.slice(2).split("?");
  const q = new URLSearchParams(query);
  const msg = Number.parseInt(q.get("msg") ?? "", 10);
  const page = Number.parseInt(q.get("page") ?? "", 10);
  const params = {
    check: CHECKS.includes(q.get("check")) ? q.get("check") : "all",
    msg: Number.isInteger(msg) && msg >= 0 ? msg : null,
    page: Number.isInteger(page) && page > 0 ? page : 1,
    tab: TABS.includes(q.get("tab")) ? q.get("tab") : "decoded",
    f: q.get("f") || null,
  };
  if (path === "capture") return { screen: "capture", params };
  if (path === "help") return { screen: "help", params };
  if (path === "frames") return { screen: "frames", params };
  const m = /^frames\/(\d{1,9})$/.exec(path);
  if (m) return { screen: "details", index: Number(m[1]), params };
  return { screen: "notfound", params };
}

function buildHash(screen, p = {}) {
  const q = new URLSearchParams();
  if (p.check && p.check !== "all") q.set("check", p.check);
  if (p.msg !== null && p.msg !== undefined) q.set("msg", String(p.msg));
  if (screen === "frames" && p.page > 1) q.set("page", String(p.page));
  if (screen === "details" && p.tab && p.tab !== "decoded") q.set("tab", p.tab);
  if (screen === "details" && p.f) q.set("f", p.f);
  const qs = q.toString();
  const path = screen === "details" ? `frames/${p.index}` : screen;
  return `#/${path}${qs ? "?" + qs : ""}`;
}

function navigate(hash, { replace = false, keepFocus = false } = {}) {
  if (hash === location.hash) { render({ keepFocus }); return; }
  history[replace ? "replaceState" : "pushState"](null, "", hash);
  render({ keepFocus });
}

// Links from the single-page inspector (#view=issues&msg=30&sel=f12) map to the new routes.
function legacyTarget(hash) {
  const r = state.result;
  const p = new URLSearchParams(hash.slice(1));
  const check = p.get("view") === "issues" ? "issues" : "all";
  const msg = Number.parseInt(p.get("msg") ?? "", 10);
  const params = { check, msg: Number.isInteger(msg) && r.messages.some((x) => x.msgid === msg) ? msg : null };
  const m = /^([fi])(\d{1,9})$/.exec(p.get("sel") || "");
  if (m) {
    const i = Number(m[2]);
    const idx = rowIndex(r);
    let pos = -1;
    if (m[1] === "f") pos = idx.positionOf({ t: "f", i });
    else if (r.issues[i]) pos = CANDIDATE_KINDS.has(r.issues[i].kind) ? idx.positionOf({ t: "i", i }) : idx.positionOf({ t: "f", i: r.issues[i].frame });
    if (pos >= 0) return buildHash("details", { ...params, index: pos });
  }
  return buildHash("frames", params);
}

const SCREENS = { capture: "screen-capture", frames: "screen-frames", details: "screen-details", help: "screen-help", notfound: "screen-notfound" };
const TITLES = { capture: "Capture", frames: "Frames", details: "Frame details", help: "Format help", notfound: "Not found" };

function render({ keepFocus = false } = {}) {
  if (state.keepFocusNext) { keepFocus = true; state.keepFocusNext = false; }
  const route = parseHash(location.hash);
  if (route.screen === "anchor") return;
  if (route.screen === "legacy") {
    if (state.result) { history.replaceState(null, "", legacyTarget(location.hash)); render(); return; }
    route.screen = "frames"; // shown as loading until the sample is parsed
  }
  if (state.route && location.hash !== state.lastHash) state.prevRoute = state.route;
  state.route = route;
  state.lastHash = location.hash;
  const wide = WIDE.matches;
  const screen = route.screen === "details" && wide ? "frames" : route.screen;
  for (const [name, id] of Object.entries(SCREENS)) $(id).hidden = name !== screen;

  // On wide screens a selected row stays on the Frames screen (the analyzer), so title, H1 and
  // breadcrumb say Frames; on narrow screens #/frames/<row> is its own Frame details screen.
  const shown = route.screen === "details" && wide ? "frames" : route.screen;
  document.title = `${TITLES[shown]} – Mavframe`;
  document.body.classList.toggle("analyzer-mode", wide && screen === "frames");
  const crumbs = ["Mavframe", ...(shown === "details" ? ["Frames", "Frame details"] : [TITLES[shown]])];
  $("crumbs").replaceChildren(...crumbs.map((c, i) => el("li", { "aria-current": i === crumbs.length - 1 ? "page" : null, text: c })));
  const nav = route.screen === "details" ? "frames" : route.screen;
  for (const a of document.querySelectorAll(".nav a[data-route]")) {
    if (a.dataset.route === nav) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  const back = $("back-link");
  back.hidden = shown !== "details";
  back.href = buildHash("frames", route.params);

  if (screen === "capture") renderCapture();
  if (screen === "frames") renderFrames(route);
  if (screen === "details") renderDetailsScreen(route);

  const changed = state.lastScreen !== null && state.lastScreen !== screen;
  const first = state.lastScreen === null;
  state.lastScreen = screen;
  if (!first && (changed || !keepFocus)) {
    if (changed) window.scrollTo(0, 0);
    $(SCREENS[screen]).querySelector("h1").focus();
  }
}

// ---------- loading ----------
function setBusy(busy, cancellable = false) {
  state.busy = busy;
  for (const id of ["load-sample", "file", "format"]) $(id).disabled = busy;
  $("cancel").hidden = !(busy && cancellable);
}

async function run(bytes, name, isSample) {
  if (state.busy) return;
  setBusy(true, true);
  const progress = $("progress");
  const ptext = $("progress-text");
  progress.hidden = ptext.hidden = false;
  progress.value = 0;
  const mb = (n) => (n / 1048576).toFixed(1);
  setStatus(`Parsing ${name} (${fmt(bytes.length)} bytes)…`);
  state.abort = new AbortController();
  try {
    const fmtChoice = $("format").value;
    const result = await analyze(bytes, {
      parser: state.parser, name, format: fmtChoice === "auto" ? undefined : fmtChoice, yieldFn: yieldToBrowser,
      signal: state.abort.signal,
      onProgress(done, total) {
        progress.value = total ? Math.round((100 * done) / total) : 100;
        ptext.textContent = `${mb(done)} of ${mb(total)} MB`;
      },
    });
    progress.value = 100;
    await yieldToBrowser();
    if (state.abort.signal.aborted) throw new DOMException("parsing cancelled", "AbortError");
    Object.assign(state, { result, bytes, name, isSample, rows: null, rowsKey: "" });
    fillMessageFilter();
    if (result.validFrames === 0) {
      setStatus(`No MAVLink v2 frames found in ${name}: ${fmt(result.skippedBytes)} of ${fmt(bytes.length)} bytes skipped` +
        (result.unsupported ? `, ${fmt(result.unsupported)} candidates with message ids outside the common dialect` : "") +
        ". Open a .tlog or raw MAVLink v2 capture (v1-only streams are not supported).", true);
    } else {
      setStatus(`${name}: ${fmt(result.validFrames)} valid frames, ${fmt(result.crcErrors)} CRC failures, ` +
        `${fmt(result.unsupported)} unsupported, ${fmt(result.gaps)} sequence gaps (~${fmt(result.missingFrames)} frames missing if in order), ` +
        `${fmt(result.skippedBytes)} skipped bytes.`);
    }
    render({ keepFocus: true });
  } catch (err) {
    if (err.name === "AbortError") setStatus(`Cancelled parsing ${name}.` + (state.result ? ` Still showing ${state.name}.` : ""));
    else setStatus(`Could not parse ${name}: ${err.message}`, true);
  } finally {
    progress.hidden = ptext.hidden = true;
    setBusy(false);
  }
}

// The status and the disabled controls change before the first await, so the
// previous result's status is never shown while a new load is running.
async function loadSample() {
  if (state.busy) return;
  setBusy(true);
  setStatus(`Loading ${SAMPLE.name}…`);
  let bytes;
  try {
    const resp = await fetch(SAMPLE.url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    bytes = new Uint8Array(await resp.arrayBuffer());
  } catch (err) {
    setStatus(`Could not load the sample: ${err.message}`, true);
    return;
  } finally {
    setBusy(false);
  }
  await run(bytes, SAMPLE.name, true);
}

async function openFile(file) {
  if (!file) return;
  if (file.size === 0) {
    setStatus(`${file.name} is empty (0 bytes). Nothing was loaded; choose a .tlog or raw MAVLink v2 capture.`, true);
    return;
  }
  if (file.size > MAX_CAPTURE_BYTES) {
    setStatus(`${file.name} is ${(file.size / 1048576).toFixed(0)} MB. The inspector reads captures up to ` +
      `${MAX_CAPTURE_BYTES / 1048576} MB in the browser to stay within memory; split the file (for example with split -b 200m) ` +
      "or use the mavframe-dump command-line tool.", true);
    return;
  }
  if (state.busy) return;
  setBusy(true);
  setStatus(`Reading ${file.name}…`);
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    setStatus(`Could not read ${file.name}: ${err.message}`, true);
    return;
  } finally {
    setBusy(false);
  }
  await run(bytes, file.name, false);
}

// ---------- Capture ----------
function renderCapture() {
  const r = state.result;
  $("capture-result").hidden = !r;
  if (!r) return;
  const s = $("source");
  s.replaceChildren(el("span", { class: "mono", text: state.name }),
    el("span", { text: `${fmt(state.bytes.length)} bytes, read as ${r.format === "tlog" ? ".tlog" : "raw stream"}` }));
  if (state.isSample) {
    s.append(el("span", { class: "label warn", text: "Engineering fixture: synthetic capture from tools/gen_sample_tlog.py, not a real flight" }));
  }
  const set = (id, main, sub, cls) => {
    const dd = $(id);
    dd.className = cls || "";
    dd.replaceChildren(main, ...(sub ? [el("span", { class: "sub", text: sub })] : []));
  };
  set("m-frames", fmt(r.validFrames), `${fmt(r.messages.length)} message type${r.messages.length === 1 ? "" : "s"}`);
  set("m-crc", fmt(r.crcErrors), "checksum did not match", r.crcErrors ? "bad" : "");
  set("m-gaps", fmt(r.gaps), `~${fmt(r.missingFrames)} frames missing if packets arrived in order; ` +
    `${fmt(r.duplicates)} duplicate, ${fmt(r.reorders)} out of order`, r.gaps ? "warn" : "");
  set("m-skipped", fmt(r.skippedBytes), `of ${fmt(r.byteLength)} bytes`);
  set("m-unsupported", fmt(r.unsupported), "unknown message id: not checked, not counted as corrupt");
  set("m-rejects", fmt(r.rejects), r.timestampArtifacts ? `incompat flags; ${fmt(r.timestampArtifacts)} 0xFD bytes inside timestamps ignored` : "unsupported incompat flags");
  set("m-duration", timeMode() ? `${((r.endTs - r.firstTs) / 1e6).toFixed(1)} s` : "n/a",
    timeMode() ? new Date(r.firstTs / 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "no timestamps in raw streams");
  $("view-frames").textContent = `View ${fmt(rowIndex(r).length)} rows in Frames`;
  renderMessages();
}

function renderMessages() {
  const r = state.result;
  const hz = (v) => (Number.isNaN(v) ? "n/a" : v.toFixed(2));
  const rows = r.messages.map((m) => {
    const many = m.sources.length > 1;
    return el("tr", {},
      el("td", { class: "num", text: m.msgid }),
      el("td", {}, el("a", { href: buildHash("frames", { msg: m.msgid }), text: m.name || `id ${m.msgid}` })),
      el("td", { class: "num", text: fmt(m.count) }),
      el("td", { class: "num", text: many ? `${hz(m.rateHz)} all` : hz(m.rateHz) }),
      el("td", { class: "num" + (m.crcErrors ? " bad" : ""), text: fmt(m.crcErrors) }),
      el("td", { class: "sources" }, ...m.sources.map((x) => el("span", { class: "src",
        text: many ? `${x.sysid}:${x.compid} at ${hz(x.rateHz)} Hz` : `${x.sysid}:${x.compid}` }))));
  });
  if (!rows.length) rows.push(el("tr", {}, el("td", { colspan: 6, class: "muted", text: "No valid MAVLink v2 frames in this capture." })));
  $("msg-table").querySelector("tbody").replaceChildren(...rows);
}

function fillMessageFilter() {
  const r = state.result;
  const ids = new Set(r.messages.map((m) => m.msgid));
  for (const it of r.issues) if (CANDIDATE_KINDS.has(it.kind)) ids.add(it.msgid);
  $("msg-filter").replaceChildren(el("option", { value: "", text: "All messages" }),
    ...[...ids].sort((a, b) => a - b).map((id) => el("option", { value: String(id), text: `${msgLabel(id)} (${id})` })));
}

// ---------- Frames: list ----------
const CHECK_TEXT = { valid: "Valid CRC", crc: "CRC failed", unsupported: "Unsupported (not checked)", reject: "Bad flags (not checked)" };
const SEQ_TEXT = { gap: "Sequence gap", duplicate: "Duplicate seq", reorder: "Out of order" };
function seqDetail(it) {
  if (it.kind === "gap") return `seq ${it.prevSeq} to ${it.seq}, ~${it.missing} missing if in order`;
  if (it.kind === "duplicate") return `seq ${it.seq} repeated`;
  return `seq ${it.seq} after ${it.prevSeq}: ${it.reset ? "likely sender restart" : "late frame"}`;
}
function noteText(info) {
  const parts = [];
  if (info.seqIssue) parts.push(`${SEQ_TEXT[info.seqIssue.kind]}: ${seqDetail(info.seqIssue)}`);
  if (info.iflags & 1) parts.push("signature present; not verified");
  return parts.join("; ");
}

function currentRows(p) {
  const key = `${p.check}|${p.msg}`;
  if (state.rowsKey !== key || !state.rows) { state.rows = filterRows(state.result, p.check, p.msg); state.rowsKey = key; }
  return state.rows;
}

function framesEmpty(box) {
  box.hidden = false;
  if (state.busy || (!state.result && !$("status").classList.contains("error"))) {
    box.replaceChildren(el("p", { text: "Parsing the capture…" }));
  } else {
    box.replaceChildren(el("p", { text: "No capture is loaded yet." }),
      el("p", {}, el("a", { class: "btn", href: "#/capture", text: "Go to Capture" }), " to open a file or load the engineering sample."));
  }
}

function renderFrames(route) {
  const r = state.result;
  if (!r) {
    $("frames-body").hidden = true;
    framesEmpty($("frames-empty"));
    return;
  }
  $("frames-empty").hidden = true;
  $("frames-body").hidden = false;
  const p = route.params;
  const wide = WIDE.matches;
  const c = (n, label) => el("span", {}, el("strong", { text: fmt(n) }), ` ${label}`);
  $("frames-counts").replaceChildren(el("span", { class: "mono", text: state.name }),
    ...(state.isSample ? [el("span", { class: "label warn", text: "Engineering fixture, not a real flight" })] : []),
    c(r.validFrames, "valid frames"), c(r.crcErrors, "CRC failures"), c(r.unsupported, "unsupported"),
    c(r.gaps, "sequence gaps"), c(r.skippedBytes, "skipped bytes"));
  for (const b of document.querySelectorAll(".chip")) b.setAttribute("aria-pressed", String(b.dataset.check === p.check));
  $("msg-filter").value = p.msg === null ? "" : String(p.msg);
  $("clear-filters").hidden = p.check === "all" && p.msg === null;

  const rows = currentRows(p);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  let page = Math.min(p.page, pages) - 1;
  const sel = route.screen === "details" ? route.index : -1;
  if (sel >= 0) { const k = rows.indexOf(sel); if (k >= 0) page = Math.floor(k / PAGE); }
  state.page = page;
  renderList(rows, page, sel, p);
  $("prev-page").disabled = page === 0;
  $("next-page").disabled = page >= pages - 1;
  const from = rows.length ? page * PAGE + 1 : 0;
  const to = Math.min(rows.length, (page + 1) * PAGE);
  $("page-info").textContent = `${fmt(from)}–${fmt(to)} of ${fmt(rows.length)} rows` +
    (r.unlistedFrames ? ` (only the first ${fmt(r.frameCount)} of ${fmt(r.validFrames)} frames are listed; the counts above include all)` : "");
  const issues = issuePositions(r);
  $("prev-issue").disabled = $("next-issue").disabled = issues.length === 0;
  renderTimeline(sel);

  $("analyzer-detail").hidden = !wide;
  document.querySelector(".analyzer").classList.toggle("wide", wide);
  if (wide) {
    $("analyzer-detail").append($("detail"));
    $("detail").hidden = false;
    renderDetail(route);
  }
}

function renderList(rows, page, sel, p) {
  const r = state.result;
  const idx = rowIndex(r);
  const trs = [];
  const end = Math.min(rows.length, (page + 1) * PAGE);
  for (let k = page * PAGE; k < end; k++) {
    const pos = rows.at(k);
    const info = rowInfo(r, idx.at(pos));
    const isSel = pos === sel;
    const link = el("a", { href: buildHash("details", { ...p, index: pos, tab: p.tab, f: null }), "aria-current": isSel ? "true" : null,
      "data-pos": pos, onkeydown: onRowKey, onclick: () => { if (WIDE.matches) state.keepFocusNext = true; } }, msgLabel(info.msgid));
    const note = noteText(info);
    trs.push(el("tr", { class: isSel ? "selected" : null, "data-off": info.off, "data-pos": pos },
      el("td", { class: "check" }, el("span", { class: `check-${info.check}`, text: CHECK_TEXT[info.check] })),
      el("td", { class: "msg" }, link),
      el("td", { class: "num", text: relTime(info.ts) || "–" }),
      el("td", { class: "num mono", text: String(info.off) }),
      el("td", { text: `${info.sysid}:${info.compid}` }),
      el("td", { class: "num", text: String(info.seq) }),
      el("td", { class: info.seqIssue ? "note-seq" : null, text: note })));
  }
  if (!trs.length) {
    trs.push(el("tr", {}, el("td", { colspan: 7 },
      el("span", { text: p.check === "all" && p.msg === null ? "No frames to show." : "No rows match these filters. " }),
      p.check === "all" && p.msg === null ? null : el("button", { type: "button", class: "btn", onclick: clearFilters, text: "Clear filters" }))));
  }
  const ae = document.activeElement;
  const hadFocus = ae && ae.closest && ae.closest("#frame-table") ? ae.dataset.pos : null;
  $("frame-table").querySelector("tbody").replaceChildren(...trs);
  const selLink = document.querySelector('#frame-table a[aria-current="true"]');
  if (selLink) selLink.closest("tr").scrollIntoView({ block: "nearest" });
  // Re-rendering replaces the links; keep keyboard focus on the same row.
  if (hadFocus !== null && hadFocus !== undefined) document.querySelector(`#frame-table a[data-pos="${hadFocus}"]`)?.focus({ preventScroll: true });
}

function onRowKey(ev) {
  if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
  ev.preventDefault();
  const p = state.route.params;
  const rows = currentRows(p);
  const k = rows.indexOf(Number(ev.currentTarget.dataset.pos)) + (ev.key === "ArrowDown" ? 1 : -1);
  if (k < 0 || k >= rows.length) return;
  const pos = rows.at(k);
  if (WIDE.matches) {
    navigate(buildHash("details", { ...p, index: pos, f: null }), { replace: true, keepFocus: true });
  } else if (Math.floor(k / PAGE) !== state.page) {
    navigate(buildHash("frames", { ...p, page: Math.floor(k / PAGE) + 1 }), { replace: true, keepFocus: true });
  }
  document.querySelector(`#frame-table a[data-pos="${pos}"]`)?.focus();
}

function setFilters(check, msg) {
  const p = state.route.params;
  navigate(buildHash("frames", { ...p, check, msg, page: 1 }), { replace: true, keepFocus: true });
}
function clearFilters() {
  setFilters("all", null);
  document.querySelector('.chip[data-check="all"]').focus();
}

function goToRow(pos) {
  const p = state.route.params;
  const rows = currentRows(p);
  const params = rows.indexOf(pos) >= 0 ? p : { ...p, check: "all", msg: null };
  navigate(buildHash("details", { ...params, index: pos, f: null }), { keepFocus: WIDE.matches });
}

function stepIssue(dir) {
  const issues = issuePositions(state.result);
  if (!issues.length) return;
  const cur = state.route.screen === "details" ? state.route.index : -1;
  let target = null;
  if (dir > 0) target = issues.find((x) => x > cur);
  else for (let i = issues.length - 1; i >= 0; i--) if (issues[i] < cur || cur < 0) { target = issues[i]; break; }
  if (target === null || target === undefined) target = dir > 0 ? issues[0] : issues[issues.length - 1];
  goToRow(target);
}

// ---------- timeline ----------
function xOf(ts, off) {
  const r = state.result;
  if (timeMode() && !Number.isNaN(ts)) return (ts - r.firstTs) / (r.endTs - r.firstTs);
  return r.byteLength ? off / r.byteLength : 0;
}

function densityBins(count) {
  const r = state.result;
  if (r.bins && r.bins.length === count) return r.bins;
  const bins = new Uint32Array(count);
  const useTime = timeMode();
  const { ts, off } = r.frames;
  const span = useTime ? r.endTs - r.firstTs : r.byteLength || 1;
  for (let i = 0; i < r.frameCount; i++) {
    const v = useTime && !Number.isNaN(ts[i]) ? (ts[i] - r.firstTs) / span : off[i] / (r.byteLength || 1);
    const k = Math.floor(v * count);
    bins[k < 0 ? 0 : k >= count ? count - 1 : k]++;
  }
  r.bins = bins;
  return bins;
}

function renderTimeline(sel) {
  const r = state.result;
  const svg = $("timeline");
  const w = Math.max(200, Math.round(svg.getBoundingClientRect().width || 800));
  const h = 76;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const bins = densityBins(Math.max(1, Math.floor(w / 3)));
  let max = 1;
  for (const c of bins) if (c > max) max = c;
  const top = 16;
  const bottom = 58;
  const kids = [];
  const bw = w / bins.length;
  bins.forEach((c, i) => {
    if (!c) return;
    const bh = Math.max(1, ((bottom - top) * c) / max);
    kids.push(svgEl("rect", { class: "bin", x: (i * bw).toFixed(1), y: (bottom - bh).toFixed(1), width: Math.max(1, bw - 1).toFixed(1), height: bh.toFixed(1) }));
  });
  kids.push(svgEl("line", { class: "base", x1: 0, x2: w, y1: bottom + 0.5, y2: bottom + 0.5 }));
  // One marker per kind and pixel column, so 100,000 issues do not create 100,000 SVG nodes.
  const drawn = new Set();
  for (const it of r.issues) {
    const x = (xOf(it.ts, it.off) * (w - 8) + 4).toFixed(1);
    const slot = `${it.kind}:${Math.round(x)}`;
    if (drawn.has(slot)) continue;
    drawn.add(slot);
    const g = svgEl("g", { class: it.kind });
    g.append(svgEl("line", { x1: x, x2: x, y1: it.kind === "gap" ? 10 : top, y2: it.kind === "crc" ? 64 : bottom }));
    if (it.kind === "crc") g.append(svgEl("path", { d: `M${x} 62 l5 10 h-10 Z` }));
    if (it.kind === "gap") g.append(svgEl("rect", { x: x - 4, y: 2, width: 8, height: 8 }));
    kids.push(g);
  }
  if (sel >= 0) {
    const ref = rowIndex(r).at(sel);
    if (ref) {
      const info = rowInfo(r, ref);
      const x = (xOf(info.ts, info.off) * (w - 8) + 4).toFixed(1);
      kids.push(svgEl("line", { class: "cursor", x1: x, x2: x, y1: 0, y2: h }));
    }
  }
  svg.replaceChildren(...kids);
  const span = timeMode() ? `${((r.endTs - r.firstTs) / 1e6).toFixed(1)} seconds` : `${fmt(r.byteLength)} bytes`;
  $("timeline-desc").textContent = `Timeline over ${span}: ${fmt(r.validFrames)} valid frames, ${fmt(r.crcErrors)} CRC failures, ${fmt(r.unsupported)} unsupported message ids, ` +
    `${fmt(r.gaps)} sequence gaps, ${fmt(r.duplicates + r.reorders)} duplicate or out-of-order sequence numbers. Use Previous issue and Next issue to step through them.`;
  $("axis-start").textContent = timeMode() ? "0 s" : "0";
  $("axis-unit").textContent = timeMode() ? "time since first frame" : "byte offset (raw streams have no timestamps)";
  $("axis-end").textContent = timeMode() ? `${((r.endTs - r.firstTs) / 1e6).toFixed(1)} s` : fmt(r.byteLength);
  const cap = $("timeline-cap");
  cap.hidden = !r.unlistedIssues && !r.unlistedFrames;
  cap.textContent = [
    r.unlistedIssues ? `Markers show the first ${fmt(r.issues.length)} of ${fmt(r.issues.length + r.unlistedIssues)} issues.` : "",
    r.unlistedFrames ? `Frame density covers the first ${fmt(r.frameCount)} of ${fmt(r.validFrames)} frames.` : "",
  ].join(" ").trim();
}

function onTimelineClick(ev) {
  const r = state.result;
  if (!r) return;
  const rect = ev.currentTarget.getBoundingClientRect();
  const fx = (ev.clientX - rect.left) / rect.width;
  const idx = rowIndex(r);
  let best = -1;
  let bestD = 8;
  r.issues.forEach((it, i) => {
    const d = Math.abs((xOf(it.ts, it.off) - fx) * rect.width);
    if (d <= bestD) { best = i; bestD = d; }
  });
  if (best >= 0) {
    const it = r.issues[best];
    const pos = CANDIDATE_KINDS.has(it.kind) ? idx.positionOf({ t: "i", i: best }) : idx.positionOf({ t: "f", i: it.frame });
    if (pos >= 0) { goToRow(pos); return; }
  }
  if (!r.frameCount) return;
  let lo = 0;
  let hi = r.frameCount - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xOf(r.frames.ts[mid], r.frames.off[mid]) < fx) lo = mid + 1; else hi = mid;
  }
  goToRow(idx.positionOf({ t: "f", i: lo }));
}

// ---------- Frame details: summary, CRC, field tree, bytes ----------
function renderDetailsScreen(route) {
  $("details-host").append($("detail"));
  $("detail").hidden = false;
  if (!state.result) {
    $("h-details").textContent = "Frame details";
    $("detail-body").hidden = true;
    framesEmpty($("detail-empty"));
    return;
  }
  renderDetail(route);
}

function renderDetail(route) {
  const r = state.result;
  const wide = WIDE.matches;
  const empty = $("detail-empty");
  const body = $("detail-body");
  const idx = rowIndex(r);
  const ref = route.screen === "details" ? idx.at(route.index) : null;
  if (!ref) {
    body.hidden = true;
    empty.hidden = false;
    $("h-details").textContent = "Frame details";
    empty.replaceChildren(route.screen === "details"
      ? el("p", {}, `There is no row ${fmt(route.index)} in ${state.name} (it has ${fmt(idx.length)} rows). `, el("a", { href: buildHash("frames", route.params), text: "Back to Frames" }))
      : el("p", { class: "muted", text: "Select a row to see its header, payload fields, CRC and bytes here. Selecting a field highlights its bytes; clicking a byte selects its field." }));
    return;
  }
  empty.hidden = true;
  body.hidden = false;
  const info = rowInfo(r, ref);
  const a = anatomy(r, state.bytes, state.parser, info);
  state.anatomy = a;
  const title = `${msgLabel(info.msgid)} at offset ${fmt(info.off)}`;
  $("h-details").textContent = title;
  $("detail-title").textContent = title;
  $("detail-title").hidden = !wide;

  const d = (k, v, cls) => el("div", {}, el("dt", { text: k }), el("dd", { class: cls || null }, v));
  $("detail-summary").replaceChildren(
    d("Check", el("span", { class: `check-${info.check}`, text: CHECK_TEXT[info.check] })),
    d("Message", `${msgLabel(info.msgid)} (id ${info.msgid})`),
    d("Offset", el("span", { class: "mono", text: String(info.off) })),
    d("Length", `${info.flen} bytes`),
    d("Time", relTime(info.ts) ? `${relTime(info.ts)} s` : "no timestamp"),
    d("Sys:Comp", `${info.sysid}:${info.compid}`),
    d("Seq", String(info.seq)),
    d("Row", fmt(route.index)));

  const cc = $("crc-compare");
  if (a.crc) {
    const computed = a.crc.computed === null ? "not possible" : hexN(a.crc.computed, 4);
    const verdict = a.crc.computed === null ? ["na", "Not checked: no CRC_EXTRA for this message id"]
      : a.crc.computed === a.crc.wire ? ["ok", "Match: valid CRC"] : ["bad", "Mismatch: CRC failed"];
    cc.replaceChildren(
      el("div", {}, el("span", { class: "k", text: "Wire CRC" }), el("span", { class: "v", text: hexN(a.crc.wire, 4) })),
      el("div", {}, el("span", { class: "k", text: "Computed CRC" }), el("span", { class: "v", text: computed })),
      el("div", { class: `verdict ${verdict[0]}` }, el("span", { class: "k", text: "Result" }), el("span", { class: "v", text: verdict[1] })));
  } else {
    const why = info.check === "unsupported"
      ? "Not checked: no CRC_EXTRA; only the candidate header was retained"
      : info.check === "reject"
        ? "Not checked: unsupported flags; only the candidate header was retained"
        : "cut off at the end of the capture";
    cc.replaceChildren(el("div", {}, el("span", { class: "k", text: "CRC" }), el("span", { class: "v", text: why })));
  }

  const notes = [];
  if (info.iflags & 1) notes.push(el("p", { class: "note", text: "Signed frame: signature present; not verified. The parser carries the 13 signature bytes without checking them (that needs the link's secret key)." }));
  if (info.seqIssue) {
    const s = info.seqIssue;
    const who = `System ${s.sysid} component ${s.compid}`;
    const text = s.kind === "gap"
      ? `${who} went from seq ${s.prevSeq} to ${s.seq}. Assuming one fully observed channel and in-order arrival, about ${s.missing} frame${s.missing === 1 ? " is" : "s are"} missing before this one. This is an estimate from sequence numbers (a late frame looks the same), not a CRC failure.`
      : s.kind === "duplicate" ? `${who} sent seq ${s.seq} twice in a row (a duplicate or retransmitted frame). Not counted as missing.`
        : `${who} went back from seq ${s.prevSeq} to ${s.seq} (${s.back} back). ` + (s.reset ? "A step this large more likely means the sender restarted." : "Most likely a late frame delivered out of order. Not counted as missing.");
    notes.push(el("p", { class: "note warn" }, el("strong", { text: `${SEQ_TEXT[s.kind]}. ` }), text));
  }
  if (info.check === "crc") notes.push(el("p", { class: "note bad", text: "The header looked valid but the checksum over header and payload does not match, so the frame was discarded. The parser then looked for the next 0xFD inside these bytes, so a valid frame hidden in them is still found." }));
  if (info.check === "unsupported") notes.push(el("p", { class: "note", text: `Message id ${info.msgid} is not in the common dialect (it may come from another dialect, such as ardupilotmega, or be noise). Without its CRC_EXTRA the checksum cannot be checked, so it is unsupported, not counted as corrupt.` }));
  if (info.check === "reject") notes.push(el("p", { class: "note", text: `Incompat flags ${hexN(info.iflags, 2)} include bits other than "signed", which this parser does not support.` }));
  $("detail-notes").replaceChildren(...notes);

  // Under the H1 on the narrow details screen the groups are h2; under the detail h2 in the analyzer, h3.
  const hTag = wide ? "h3" : "h2";
  const groupTable = (g) => {
    const kids = [el(hTag, { text: g.title })];
    if (g.description) kids.push(el("p", { class: "muted small", text: g.description }));
    if (g.fields.length) {
      kids.push(el("div", { class: "table-wrap" }, el("table", { class: "dense" },
        el("caption", { class: "sr-only", text: `${g.title} fields` }),
        el("thead", {}, el("tr", {}, ...["Field", "Value", "Reading", "Bytes"].map((h) => el("th", { scope: "col", text: h })))),
        el("tbody", {}, ...g.fields.map((f) => el("tr", { class: f.trimmed ? "trimmed" : null },
          el("td", {}, el("button", { type: "button", class: "fieldbtn", "data-key": f.key, "aria-pressed": "false", onclick: () => selectField(f.key, true) }, f.name)),
          el("td", { class: /^0x/.test(f.value) ? "val mono" : "val", text: f.value + (f.units ? ` ${f.units}` : "") }),
          el("td", { text: f.trimmed ? [f.reading, "not sent (trimmed zero bytes)"].filter(Boolean).join("; ") : f.reading }),
          el("td", { class: "bytes", text: byteRange(f.from - a.off, f.to - 1 - a.off) })))))));
    } else if (g.note) {
      kids.push(el("p", { class: "note", text: g.note }));
    }
    if (g.trimmed) kids.push(el("p", { class: "note", text: `The sender trimmed trailing zero bytes (MAVLink v2): ${a.plen} of ${g.length} payload bytes were sent; the rest read as zero.` }));
    return kids;
  };
  const tree = (ids) => el("div", { class: "tree" }, ...ids.map((id) => a.groups.find((g) => g.id === id)).filter(Boolean).flatMap(groupTable));
  // The analyzer reads header fields first, as a packet analyzer's tree does; the tlog record follows.
  $("panel-header").replaceChildren(tree(wide ? ["header", "ts", "crc", "sig"] : ["ts", "header", "crc", "sig"]));
  $("panel-decoded").replaceChildren(tree(["payload"]));

  // Tabs on narrow screens; all three panes at once on wide screens.
  const tab = route.params.tab;
  for (const t of TABS) {
    const btn = $(`tab-${t}`);
    const panel = $(`panel-${t}`);
    const on = t === tab;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
    if (wide) { panel.removeAttribute("role"); panel.removeAttribute("aria-labelledby"); panel.hidden = false; panel.removeAttribute("tabindex"); }
    else { panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `tab-${t}`); panel.hidden = !on; }
  }
  // Decoded payload fields come before header fields in the narrow Decoded tab; on wide
  // screens the tree reads header first, as in a packet analyzer.
  $("panel-header").parentElement.classList.toggle("header-first", wide);
  if (wide) $("panel-header").parentElement.prepend($("panel-header"));
  else $("panel-header").parentElement.append($("panel-header"));

  renderHex(a);
  const key = route.params.f && a.fields.some((f) => f.key === route.params.f) ? route.params.f : null;
  selectField(key, false);
  $("export-status").textContent = "";
  const rows = currentRows(route.params);
  const k = rows.indexOf(route.index);
  $("prev-row").disabled = k <= 0 && route.index <= 0;
  $("next-row").disabled = k >= 0 ? k >= rows.length - 1 : route.index >= idx.length - 1;
}

// Byte positions relative to the frame's start byte ("−8 to −1" for the tlog timestamp).
function byteRange(from, last) {
  const n = (v) => (v < 0 ? `−${-v}` : String(v));
  if (last < from) return "–";
  if (last === from) return n(from);
  return from < 0 ? `${n(from)} to ${n(last)}` : `${n(from)}–${n(last)}`;
}

// 16 bytes per row like a packet analyzer; 8 or 4 when a row (with the ASCII column) does not fit the pane.
function renderHex(a, perRow = 16) {
  const bytes = state.bytes;
  const pre = $("hex");
  const start = a.start;
  const end = a.end;
  if (start >= end) { pre.textContent = "No bytes."; return; }
  const segs = [];
  for (const g of a.groups) {
    const cls = { ts: "seg-ts", header: "seg-hdr", payload: "seg-pay", crc: "seg-crc", sig: "seg-sig" }[g.id];
    const name = { ts: "tlog timestamp", header: "header", payload: "payload", crc: "CRC", sig: "signature" }[g.id];
    const from = g.id === "payload" ? a.off + 10 : Math.min(...g.fields.map((f) => f.from));
    const to = g.id === "payload" ? a.off + 10 + a.plen : Math.max(...g.fields.map((f) => f.to));
    if (Number.isFinite(from) && to > from) segs.push({ from, to: Math.min(to, end), cls, name });
  }
  const segOf = (o) => segs.find((s) => o >= s.from && o < s.to);
  const frag = document.createDocumentFragment();
  const base = start - (start % perRow);
  for (let row = base; row < end; row += perRow) {
    frag.append(el("span", { class: "off", text: row.toString(16).padStart(8, "0") }), "  ");
    let ascii = "";
    for (let o = row; o < row + perRow; o++) {
      if (o >= start && o < end) {
        const s = segOf(o);
        // Screen readers get the region name where it starts; sighted users get the underline pattern.
        if (s && (o === s.from || o === start)) frag.append(el("span", { class: "sr-only", text: `${s.name}: ` }));
        frag.append(el("span", { class: "b " + (s ? s.cls : ""), "data-o": o, title: s ? s.name : null, text: hex2(bytes[o]) }));
        ascii += bytes[o] >= 0x20 && bytes[o] < 0x7f ? String.fromCharCode(bytes[o]) : ".";
      } else {
        frag.append("  ");
        ascii += " ";
      }
      frag.append(o === row + 7 && perRow === 16 ? "  " : " ");
    }
    frag.append(el("span", { class: "ascii", text: " " + ascii }), "\n");
  }
  pre.replaceChildren(frag);
  pre.setAttribute("aria-label", `Bytes ${fmt(start)} to ${fmt(end - 1)} in hexadecimal`);
  if (perRow > 4 && pre.clientWidth && pre.scrollWidth > pre.clientWidth + 1) renderHex(a, perRow / 2);
}

// Linked selection: a field highlights its bytes; a byte selects its field.
function selectField(key, fromUser) {
  const a = state.anatomy;
  if (!a) return;
  const f = key ? a.fields.find((x) => x.key === key) : null;
  for (const b of document.querySelectorAll("#detail .fieldbtn")) b.setAttribute("aria-pressed", String(!!f && b.dataset.key === f.key));
  for (const s of document.querySelectorAll("#hex .b.hl")) s.classList.remove("hl");
  let firstByte = null;
  if (f) {
    for (let o = f.from; o < f.to; o++) {
      const s = document.querySelector(`#hex .b[data-o="${o}"]`);
      if (s) { s.classList.add("hl"); firstByte ??= s; }
    }
  }
  if (!fromUser) return;
  if (firstByte && !$("panel-bytes").hidden) firstByte.scrollIntoView({ block: "nearest", inline: "nearest" });
  const route = state.route;
  history.replaceState(null, "", buildHash("details", { ...route.params, index: route.index, f: f ? f.key : null }));
  state.route = parseHash(location.hash);
  state.lastHash = location.hash;
  const n = f ? f.to - f.from : 0;
  $("field-status").textContent = !f ? "" : n
    ? `${f.name}: ${n} byte${n === 1 ? "" : "s"} at offset ${fmt(f.from)} highlighted${$("panel-bytes").hidden ? " in the Bytes tab" : ""}.`
    : `${f.name}: not sent (trimmed zero bytes).`;
}

function onHexClick(ev) {
  const span = ev.target.closest(".b");
  if (!span || !state.anatomy) return;
  const o = Number(span.dataset.o);
  const hits = state.anatomy.fields.filter((f) => o >= f.from && o < f.to).sort((x, y) => (x.to - x.from) - (y.to - y.from));
  if (hits.length) selectField(hits[0].key, true);
}

function onHexKey(ev) {
  if ((ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") || !state.anatomy) return;
  ev.preventDefault();
  const fields = state.anatomy.fields.filter((f) => f.to > f.from).sort((x, y) => x.from - y.from || x.to - y.to);
  const cur = fields.findIndex((f) => f.key === state.route.params.f);
  const next = cur < 0 ? (ev.key === "ArrowRight" ? 0 : fields.length - 1) : Math.max(0, Math.min(fields.length - 1, cur + (ev.key === "ArrowRight" ? 1 : -1)));
  if (fields[next]) selectField(fields[next].key, true);
}

function selectTab(t, focus) {
  const route = state.route;
  navigate(buildHash("details", { ...route.params, index: route.index, tab: t }), { replace: true, keepFocus: true });
  if (focus) $(`tab-${t}`).focus();
}

function onTabKey(ev) {
  const i = TABS.indexOf(ev.currentTarget.id.slice(4));
  let j = null;
  if (ev.key === "ArrowRight") j = (i + 1) % TABS.length;
  else if (ev.key === "ArrowLeft") j = (i + TABS.length - 1) % TABS.length;
  else if (ev.key === "Home") j = 0;
  else if (ev.key === "End") j = TABS.length - 1;
  if (j === null) return;
  ev.preventDefault();
  selectTab(TABS[j], true);
}

function stepRow(dir) {
  const route = state.route;
  const rows = currentRows(route.params);
  const k = rows.indexOf(route.index);
  let pos;
  let params = route.params;
  if (k >= 0) pos = rows.at(k + dir);
  else { pos = route.index + dir; params = { ...params, check: "all", msg: null }; }
  if (pos < 0 || pos >= rowIndex(state.result).length) return;
  navigate(buildHash("details", { ...params, index: pos, f: null }), { replace: true, keepFocus: true });
}

async function exportFinding() {
  const route = state.route;
  const ref = rowIndex(state.result).at(route.index);
  if (!ref) return;
  const includeAll = $("include-payload").checked;
  const f = await buildFinding({ result: state.result, bytes: state.bytes, parser: state.parser, ref, fileName: state.name,
    isSample: state.isSample, includeAllPayloads: includeAll });
  const base = state.name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.[^.]*$/, "") || "capture";
  const file = `mavframe-finding-${base}-offset-${f.finding.offset}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(f, null, 2) + "\n"], { type: "application/json" }));
  const a = el("a", { href: url, download: file, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("export-status").textContent = `Exported ${file}: ${f.bytes.payload_hex !== undefined ? "includes the payload bytes" : "payload bytes left out (may carry GPS/position data)"}` +
    (f.file.sha256 ? "." : "; SHA-256 unavailable outside a secure context.");
}

// ---------- menu sheet and theme ----------
const focusables = (root) => [...root.querySelectorAll("a[href], button:not([disabled]), select, input, [tabindex='0']")].filter((e) => e.offsetParent !== null);

function openSheet() {
  const app = document.querySelector(".app");
  app.classList.add("sheet-open");
  $("scrim").hidden = false;
  const sheet = $("sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Menu");
  $("main-col").inert = true;
  $("menu-btn").setAttribute("aria-expanded", "true");
  (sheet.querySelector('.nav a[aria-current="page"]') || $("sheet-close")).focus();
}

function closeSheet(returnFocus = true) {
  const app = document.querySelector(".app");
  if (!app.classList.contains("sheet-open")) return;
  app.classList.remove("sheet-open");
  $("scrim").hidden = true;
  const sheet = $("sheet");
  for (const a of ["role", "aria-modal", "aria-label"]) sheet.removeAttribute(a);
  $("main-col").inert = false;
  $("menu-btn").setAttribute("aria-expanded", "false");
  if (returnFocus) $("menu-btn").focus();
}

function onSheetKey(ev) {
  if (!document.querySelector(".app").classList.contains("sheet-open")) return;
  if (ev.key === "Escape") { ev.preventDefault(); closeSheet(true); return; }
  if (ev.key !== "Tab") return;
  const items = focusables($("sheet"));
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  if (ev.shiftKey && (i <= 0)) { ev.preventDefault(); items[items.length - 1].focus(); }
  else if (!ev.shiftKey && (i === items.length - 1 || i < 0)) { ev.preventDefault(); items[0].focus(); }
}

function applyTheme(dark) {
  if (dark) document.documentElement.setAttribute("data-theme", "dark"); else document.documentElement.removeAttribute("data-theme");
  $("theme-toggle").setAttribute("aria-pressed", String(dark));
  document.querySelector('meta[name="theme-color"]').setAttribute("content", dark ? "#0f1720" : "#f7f8fa");
  document.querySelector('meta[name="color-scheme"]').setAttribute("content", dark ? "dark" : "light");
  if (state.result && !$("screen-frames").hidden) renderTimeline(state.route?.screen === "details" ? state.route.index : -1);
}

function toggleTheme() {
  const dark = document.documentElement.getAttribute("data-theme") !== "dark";
  applyTheme(dark);
  try { window.localStorage.setItem("mavframe-theme", dark ? "dark" : "light"); } catch { /* storage blocked: choice lasts for this page only */ }
}

// ---------- wiring ----------
function wire() {
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark");
  $("theme-toggle").addEventListener("click", toggleTheme);
  $("menu-btn").addEventListener("click", openSheet);
  $("sheet-close").addEventListener("click", () => closeSheet(true));
  $("scrim").addEventListener("click", () => closeSheet(true));
  document.addEventListener("keydown", onSheetKey);
  for (const a of document.querySelectorAll(".nav a, .wordmark a")) a.addEventListener("click", () => closeSheet(false));
  WIDE.addEventListener("change", () => { closeSheet(false); render({ keepFocus: true }); });
  $("skip").addEventListener("click", (ev) => {
    ev.preventDefault();
    const h1 = [...document.querySelectorAll("main h1")].find((h) => h.offsetParent !== null);
    (h1 || $("workspace")).focus();
  });
  $("back-link").addEventListener("click", (ev) => {
    if (state.prevRoute && state.prevRoute.screen === "frames") { ev.preventDefault(); history.back(); }
  });
  window.addEventListener("hashchange", () => { if (location.hash !== state.lastHash) render(); });
  window.addEventListener("popstate", () => { if (location.hash !== state.lastHash) render(); });

  $("load-sample").addEventListener("click", async () => {
    await loadSample();
    // The button is disabled while loading, which drops keyboard focus; give it back.
    if (document.activeElement === document.body) $("load-sample").focus();
  });
  $("cancel").addEventListener("click", () => state.abort?.abort());
  $("file").addEventListener("change", (e) => { openFile(e.target.files[0]); e.target.value = ""; });
  $("format").addEventListener("change", () => { if (state.bytes) run(state.bytes, state.name, state.isSample); });

  for (const chip of document.querySelectorAll(".chip")) chip.addEventListener("click", () => setFilters(chip.dataset.check, state.route.params.msg));
  $("msg-filter").addEventListener("change", (e) => setFilters(state.route.params.check, e.target.value === "" ? null : Number(e.target.value)));
  $("clear-filters").addEventListener("click", clearFilters);
  const page = (step, self, other) => {
    const p = state.route.params;
    navigate(buildHash("frames", { ...p, page: state.page + 1 + step }), { replace: true, keepFocus: true });
    if ($(self).disabled) $(other).focus();
  };
  $("prev-page").addEventListener("click", () => page(-1, "prev-page", "next-page"));
  $("next-page").addEventListener("click", () => page(1, "next-page", "prev-page"));
  $("prev-issue").addEventListener("click", () => stepIssue(-1));
  $("next-issue").addEventListener("click", () => stepIssue(1));
  $("timeline").addEventListener("click", onTimelineClick);
  let t = 0;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => { if (state.result && !$("screen-frames").hidden) renderTimeline(state.route?.screen === "details" ? state.route.index : -1); }, 100); }).observe($("timeline"));
  let th = 0;
  new ResizeObserver(() => {
    clearTimeout(th);
    th = setTimeout(() => { if (state.anatomy && !$("detail-body").hidden) { renderHex(state.anatomy); selectField(state.route?.params.f || null, false); } }, 100);
  }).observe($("hex"));

  for (const tname of TABS) {
    $(`tab-${tname}`).addEventListener("click", () => selectTab(tname, false));
    $(`tab-${tname}`).addEventListener("keydown", onTabKey);
  }
  $("hex").addEventListener("click", onHexClick);
  $("hex").addEventListener("keydown", onHexKey);
  $("export-finding").addEventListener("click", () => {
    exportFinding().catch((err) => { $("export-status").textContent = `Could not export the finding: ${err.message}`; });
  });
  $("prev-row").addEventListener("click", () => stepRow(-1));
  $("next-row").addEventListener("click", () => stepRow(1));
}

async function main() {
  wire();
  render();
  setBusy(true);
  try {
    state.parser = await loadParser("mavframe.wasm");
  } catch (err) {
    setStatus(`Could not load the parser (mavframe.wasm): ${err.message}`, true);
    setBusy(false);
    $("load-sample").disabled = true;
    render({ keepFocus: true });
    return;
  }
  setBusy(false);
  await loadSample();
  if (!state.result) render({ keepFocus: true });
}

main();
