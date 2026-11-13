// UI for the mavframe inspector. Analysis lives in core.js; this file only
// renders. Everything taken from a capture is inserted with textContent.
import {
  loadParser, analyze, frameAt, decodePayload, formatValue, messageName, MAX_CAPTURE_BYTES,
} from "./core.js";

const SAMPLE = { url: "sample/sample-flight.tlog", name: "sample-flight.tlog" };
const PAGE = 100;
const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("en-US");

const state = {
  parser: null, result: null, bytes: null, name: "", isSample: false, busy: false,
  view: "frames", msg: null, sel: null, page: 0, rows: null, pendingHash: null,
};

// ---------- small DOM helpers ----------
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
const hexN = (v, n) => "0x" + v.toString(16).toUpperCase().padStart(n, "0");
const msgLabel = (id) => messageName(id) || `id ${id}`;

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

function relTime(ts) {
  const r = state.result;
  if (!r || Number.isNaN(ts) || Number.isNaN(r.firstTs)) return "";
  return ((ts - r.firstTs) / 1e6).toFixed(3);
}
const timeMode = () => state.result && !Number.isNaN(state.result.firstTs) && state.result.endTs > state.result.firstTs;

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
    Object.assign(state, { result, bytes, name, isSample, sel: null, page: 0, rows: null });
    const hash = state.pendingHash;
    state.pendingHash = null;
    if (hash && isSample) applyHash(hash);
    else Object.assign(state, { view: "frames", msg: null });
    renderSource();
    renderSummary();
    renderMessages();
    if (!state.sel && result.frameCount) state.sel = { t: "f", i: 0 };
    renderList();
    renderTimeline();
    renderDetail();
    if (result.validFrames === 0) {
      setStatus(`No MAVLink v2 frames found in ${name}: ${fmt(result.skippedBytes)} of ${fmt(bytes.length)} bytes skipped` +
        (result.unsupported ? `, ${fmt(result.unsupported)} candidates with message ids outside the common dialect` : "") +
        ". Open a .tlog or raw MAVLink v2 capture (v1-only streams are not supported).", true);
    } else {
      setStatus(`${name}: ${fmt(result.validFrames)} valid frames, ${fmt(result.crcErrors)} CRC errors, ` +
        `${fmt(result.unsupported)} unsupported, ${fmt(result.gaps)} sequence gaps (~${fmt(result.missingFrames)} frames missing if in order), ` +
        `${fmt(result.skippedBytes)} skipped bytes.`);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      setStatus(`Cancelled parsing ${name}.` + (state.result ? ` Still showing ${state.name}.` : ""));
    } else {
      setStatus(`Could not parse ${name}: ${err.message}`, true);
    }
  } finally {
    progress.hidden = ptext.hidden = true;
    setBusy(false);
  }
}

// The status and the disabled controls change before the first await, so
// the previous result's status is never shown while a new load is running.
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

function renderSource() {
  const s = $("source");
  s.replaceChildren(el("span", { class: "mono", text: state.name }),
    el("span", { text: `${fmt(state.bytes.length)} bytes, read as ${state.result.format === "tlog" ? ".tlog" : "raw stream"}` }));
  if (state.isSample) s.append(el("span", { class: "label warn", text: "Synthetic sample: generated, not a real flight" }));
}

// ---------- rendering ----------
function renderSummary() {
  const r = state.result;
  const set = (id, main, sub, cls) => {
    const dd = $(id);
    dd.className = cls || "";
    dd.replaceChildren(main, ...(sub ? [el("span", { class: "sub", text: sub })] : []));
  };
  set("m-frames", fmt(r.validFrames), `${fmt(r.messages.length)} message type${r.messages.length === 1 ? "" : "s"}`);
  set("m-crc", fmt(r.crcErrors), null, r.crcErrors ? "bad" : "");
  set("m-gaps", fmt(r.gaps), `~${fmt(r.missingFrames)} frames missing if packets arrived in order; ` +
    `${fmt(r.duplicates)} duplicate, ${fmt(r.reorders)} out of order`, r.gaps ? "warn" : "");
  set("m-skipped", fmt(r.skippedBytes), `of ${fmt(r.byteLength)} bytes`);
  set("m-unsupported", fmt(r.unsupported), "unknown message id: not checked, not counted as corrupt");
  set("m-rejects", fmt(r.rejects), r.timestampArtifacts ? `incompat flags; ${fmt(r.timestampArtifacts)} 0xFD bytes inside timestamps ignored` : "unsupported incompat flags");
  set("m-duration", timeMode() ? `${((r.endTs - r.firstTs) / 1e6).toFixed(1)} s` : "n/a",
    timeMode() ? new Date(r.firstTs / 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "no timestamps in raw streams");
}

// Long message names may wrap only after an underscore, never mid-word.
function breakAtUnderscores(name) {
  const parts = name.split("_");
  return parts.flatMap((p, i) => (i < parts.length - 1 ? [p + "_", document.createElement("wbr")] : [p]));
}

function renderMessages() {
  const r = state.result;
  const tbody = $("msg-table").querySelector("tbody");
  const rows = r.messages.map((m) => {
    const pressed = state.msg === m.msgid;
    const btn = el("button", { type: "button", class: "rowbtn msgbtn", "aria-pressed": pressed ? "true" : "false",
      onclick: () => setFilter(pressed ? null : m.msgid) }, ...breakAtUnderscores(m.name || `id ${m.msgid}`));
    const hz = (v) => (Number.isNaN(v) ? "n/a" : v.toFixed(2));
    const many = m.sources.length > 1;
    const sources = el("td", { class: "sources" }, ...m.sources.map((x) => el("span", { class: "src mono",
      text: many ? `${x.sysid}:${x.compid} at ${hz(x.rateHz)} Hz` : `${x.sysid}:${x.compid}` })));
    return el("tr", { class: pressed ? "selected" : null },
      el("td", { class: "num", text: m.msgid }),
      el("td", {}, btn),
      el("td", { class: "num", text: fmt(m.count) }),
      el("td", { class: "num", text: many ? `${hz(m.rateHz)} all` : hz(m.rateHz) }),
      el("td", { class: "num" + (m.crcErrors ? " bad" : ""), text: fmt(m.crcErrors) }),
      sources);
  });
  if (!rows.length) rows.push(el("tr", {}, el("td", { colspan: 6, class: "muted", text: "No valid MAVLink v2 frames in this capture." })));
  tbody.replaceChildren(...rows);
}

function xOf(ts, off) {
  const r = state.result;
  if (timeMode() && !Number.isNaN(ts)) return (ts - r.firstTs) / (r.endTs - r.firstTs);
  return r.byteLength ? off / r.byteLength : 0;
}

// Frames per timeline bin, cached per result and bin count.
function densityBins(count) {
  const r = state.result;
  if (r.bins && r.bins.length === count) return r.bins;
  const bins = new Uint32Array(count);
  const useTime = timeMode();
  const { ts, off } = r.frames;
  const t0 = r.firstTs;
  const span = useTime ? r.endTs - r.firstTs : r.byteLength || 1;
  for (let i = 0; i < r.frameCount; i++) {
    const v = useTime && !Number.isNaN(ts[i]) ? (ts[i] - t0) / span : off[i] / (r.byteLength || 1);
    const k = Math.floor(v * count);
    bins[k < 0 ? 0 : k >= count ? count - 1 : k]++;
  }
  r.bins = bins;
  return bins;
}

function renderTimeline() {
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
  // One marker per kind and pixel column, so a capture with 100,000 issues
  // does not create 100,000 SVG nodes.
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
  const cur = selectedPoint();
  if (cur) {
    const x = (xOf(cur.ts, cur.off) * (w - 8) + 4).toFixed(1);
    kids.push(svgEl("line", { class: "cursor", x1: x, x2: x, y1: 0, y2: h }));
  }
  svg.replaceChildren(...kids);
  const span = timeMode() ? `${((r.endTs - r.firstTs) / 1e6).toFixed(1)} seconds` : `${fmt(r.byteLength)} bytes`;
  $("timeline-desc").textContent = `Timeline over ${span}: ${fmt(r.validFrames)} valid frames, ${fmt(r.crcErrors)} CRC errors, ${fmt(r.unsupported)} unsupported message ids, ` +
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

function selectedPoint() {
  const r = state.result;
  if (!r || !state.sel) return null;
  if (state.sel.t === "f") return { ts: r.frames.ts[state.sel.i], off: r.frames.off[state.sel.i] };
  const it = r.issues[state.sel.i];
  return it ? { ts: it.ts, off: it.off } : null;
}

function onTimelineClick(ev) {
  const r = state.result;
  if (!r) return;
  const rect = ev.currentTarget.getBoundingClientRect();
  const fx = (ev.clientX - rect.left) / rect.width;
  const px = (v) => v * rect.width;
  let best = -1;
  let bestD = 8;
  r.issues.forEach((it, i) => {
    const d = Math.abs(px(xOf(it.ts, it.off)) - px(fx));
    if (d <= bestD) { best = i; bestD = d; }
  });
  if (best >= 0) {
    if (state.view !== "issues") setView("issues", false);
    select({ t: "i", i: best }, { scroll: true });
    return;
  }
  if (!r.frameCount) return;
  let lo = 0;
  let hi = r.frameCount - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xOf(r.frames.ts[mid], r.frames.off[mid]) < fx) lo = mid + 1; else hi = mid;
  }
  if (state.view !== "frames" || (state.msg !== null && r.frames.msgid[lo] !== state.msg)) {
    state.msg = null;
    setView("frames", false);
    renderMessages();
  }
  select({ t: "f", i: lo }, { scroll: true });
}

// Rows of the list for the current view and filter: frame indices or issue
// indices. The unfiltered frame list of a large capture is not materialised.
function listRows() {
  const r = state.result;
  if (state.rows) return state.rows;
  if (state.view === "frames" && state.msg === null) {
    const n = r.frameCount;
    state.rows = { length: n, at: (k) => k, indexOf: (i) => (i >= 0 && i < n ? i : -1),
      slice: (a, b) => Array.from({ length: Math.max(0, Math.min(b, n) - a) }, (_, k) => a + k) };
    return state.rows;
  }
  const out = [];
  if (state.view === "frames") {
    const ids = r.frames.msgid;
    for (let i = 0; i < r.frameCount; i++) if (ids[i] === state.msg) out.push(i);
  } else {
    r.issues.forEach((it, i) => { if (state.msg === null || it.msgid === state.msg) out.push(i); });
  }
  state.rows = out;
  return out;
}

const ISSUE_TEXT = { crc: "CRC error", gap: "Sequence gap", duplicate: "Duplicate seq", reorder: "Out of order",
  unsupported: "Unsupported id", reject: "Bad flags" };
const SEQ_KINDS = new Set(["gap", "duplicate", "reorder"]);

function issueDetail(it) {
  if (it.kind === "gap") return `seq ${it.prevSeq} to ${it.seq}, ~${it.missing} missing if in order`;
  if (it.kind === "duplicate") return `seq ${it.seq} repeated`;
  if (it.kind === "reorder") return `seq ${it.seq} after ${it.prevSeq}: ${it.reset ? "likely sender restart" : "late frame"}`;
  if (it.kind === "crc") return `${it.flen} bytes, checksum does not match`;
  return it.kind === "unsupported" ? `message id ${it.msgid} not in the common dialect; not checked` : `incompat flags ${hexN(it.iflags, 2)}`;
}

function renderList() {
  const r = state.result;
  const rows = listRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  state.page = Math.min(state.page, pages - 1);
  const wrap = $("list-table").parentElement;
  wrap.classList.toggle("no-time", !timeMode());
  const head = state.view === "frames"
    ? ["No.", "Time (s)", "Offset", "Message", "Sys:Comp", "Seq", "Len", "Note"]
    : ["No.", "Time (s)", "Offset", "Issue", "Message", "Sys:Comp", "Detail"];
  const numeric = new Set(["No.", "Time (s)", "Offset", "Seq", "Len"]);
  $("list-table").querySelector("thead tr").replaceChildren(...head.map((hd) =>
    el("th", { scope: "col", class: [numeric.has(hd) ? "num" : "", hd === "Time (s)" ? "col-time" : ""].join(" ").trim() || null, text: hd })));

  const gapAt = new Map();
  if (state.view === "frames") for (const it of r.issues) if (SEQ_KINDS.has(it.kind)) gapAt.set(it.frame, it);
  const trs = [];
  for (const idx of rows.slice(state.page * PAGE, state.page * PAGE + PAGE)) {
    const isSel = state.sel && state.sel.t === (state.view === "frames" ? "f" : "i") && state.sel.i === idx;
    const label = state.view === "frames" ? "Select frame " : "Select issue ";
    const btn = el("button", { type: "button", class: "rowbtn", "data-idx": idx, "aria-current": isSel ? "true" : null,
      onclick: () => select({ t: state.view === "frames" ? "f" : "i", i: idx }), onkeydown: onRowKey },
    el("span", { class: "sr-only", text: label }), String(idx + 1));
    let cells;
    if (state.view === "frames") {
      const f = frameAt(r, idx);
      const gap = gapAt.get(idx);
      cells = [
        el("td", { class: "num col-time", text: relTime(f.ts) }),
        el("td", { class: "num", text: fmt(f.off) }),
        el("td", { text: msgLabel(f.msgid) }),
        el("td", { class: "mono", text: `${f.sysid}:${f.compid}` }),
        el("td", { class: "num", text: f.seq }),
        el("td", { class: "num", text: f.flen }),
        el("td", { class: gap ? "note-gap" : null, text: gap ? `${ISSUE_TEXT[gap.kind]}: ${issueDetail(gap)}` : (f.iflags & 1 ? "signature present; not verified" : "") }),
      ];
    } else {
      const it = r.issues[idx];
      cells = [
        el("td", { class: "num col-time", text: relTime(it.ts) }),
        el("td", { class: "num", text: fmt(it.off) }),
        el("td", {}, el("span", { class: `kind ${it.kind}`, text: ISSUE_TEXT[it.kind] })),
        el("td", { text: msgLabel(it.msgid) }),
        el("td", { class: "mono", text: `${it.sysid}:${it.compid}` }),
        el("td", { text: issueDetail(it) }),
      ];
    }
    trs.push(el("tr", { class: isSel ? "selected" : null }, el("td", { class: "num" }, btn), ...cells));
  }
  if (!trs.length) {
    trs.push(el("tr", {}, el("td", { colspan: head.length, class: "muted",
      text: state.view === "issues" ? "No issues: every frame passed its CRC and no sequence numbers were skipped." : "No frames to show." })));
  }
  $("list-table").querySelector("tbody").replaceChildren(...trs);
  const from = rows.length ? state.page * PAGE + 1 : 0;
  const to = Math.min(rows.length, (state.page + 1) * PAGE);
  $("page-info").textContent = `${fmt(from)}–${fmt(to)} of ${fmt(rows.length)} ${state.view === "frames" ? "frames" : "issues"}` +
    (state.view === "frames" && r.unlistedFrames && state.msg === null ? ` (only the first ${fmt(r.frameCount)} of ${fmt(r.validFrames)} frames are listed; the counts above include all)` : "") +
    (state.view === "issues" && r.unlistedIssues ? ` (only the first ${fmt(r.issues.length)} of ${fmt(r.issues.length + r.unlistedIssues)} issues are listed; the counts above include all)` : "");
  $("prev-page").disabled = state.page === 0;
  $("next-page").disabled = state.page >= pages - 1;
  $("view-frames").setAttribute("aria-pressed", String(state.view === "frames"));
  $("view-issues").setAttribute("aria-pressed", String(state.view === "issues"));
  $("view-issues").textContent = `Issues (${fmt(r.issues.length + r.unlistedIssues)})`;
  $("filter").hidden = state.msg === null;
  $("filter-text").textContent = state.msg === null ? "" : `Showing ${msgLabel(state.msg)} only`;
  $("prev-issue").disabled = $("next-issue").disabled = r.issues.length === 0;
}

function onRowKey(ev) {
  if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
  ev.preventDefault();
  const rows = listRows();
  const k = rows.indexOf(Number(ev.currentTarget.dataset.idx)) + (ev.key === "ArrowDown" ? 1 : -1);
  if (k < 0 || k >= rows.length) return;
  const next = rows.at(k);
  select({ t: state.view === "frames" ? "f" : "i", i: next }, { focus: true, scroll: true });
}

function setView(view, render = true) {
  state.view = view;
  state.rows = null;
  state.page = 0;
  if (render) { renderList(); writeHash(); }
}

function setFilter(msgid) {
  state.msg = msgid;
  state.rows = null;
  state.page = 0;
  renderMessages();
  renderList();
  writeHash();
}

function select(sel, opts = {}) {
  state.sel = sel;
  const rows = listRows();
  const kind = state.view === "frames" ? "f" : "i";
  if (sel.t === kind) {
    const pos = rows.indexOf(sel.i);
    if (pos >= 0) state.page = Math.floor(pos / PAGE);
  }
  renderList();
  renderTimeline();
  renderDetail();
  if (!opts.quiet) writeHash();
  const btn = document.querySelector(`#list-table .rowbtn[aria-current="true"]`);
  if (btn && opts.focus) btn.focus();
  if (btn && opts.scroll) btn.closest("tr").scrollIntoView({ block: "nearest" });
}

function stepIssue(dir) {
  const r = state.result;
  if (!r || !r.issues.length) return;
  let target;
  if (state.sel && state.sel.t === "i") target = state.sel.i + dir;
  else {
    const f = state.sel ? state.sel.i : -1;
    if (dir > 0) target = r.issues.findIndex((it) => it.frame > f);
    else target = r.issues.findLastIndex((it) => it.frame <= f);
  }
  if (target < 0 || target >= r.issues.length) target = dir > 0 ? 0 : r.issues.length - 1;
  if (state.msg !== null && r.issues[target].msgid !== state.msg) { state.msg = null; renderMessages(); }
  if (state.view !== "issues") setView("issues", false);
  state.rows = null;
  select({ t: "i", i: target }, { scroll: true });
}

// ---------- hex and decoded panes ----------
function renderHex(start, end, segs) {
  const bytes = state.bytes;
  const pre = $("hex");
  if (start >= end) { pre.textContent = "No bytes."; return; }
  const frag = document.createDocumentFragment();
  const segOf = (o) => segs.find((s) => o >= s.from && o < s.to);
  for (let row = start; row < end; row += 16) {
    frag.append(el("span", { class: "off", text: row.toString(16).padStart(8, "0") }), "  ");
    let ascii = "";
    for (let o = row; o < row + 16; o++) {
      if (o < end) {
        const s = segOf(o);
        frag.append(el("span", { class: "b " + (s ? s.cls : ""), title: s ? s.name : null, text: hex2(bytes[o]) }));
        ascii += bytes[o] >= 0x20 && bytes[o] < 0x7f ? String.fromCharCode(bytes[o]) : ".";
      } else {
        frag.append("  ");
      }
      frag.append(o === row + 7 ? "  " : " ");
    }
    frag.append(el("span", { class: "ascii", text: " " + ascii }), "\n");
  }
  pre.replaceChildren(frag);
}

function table(caption, head, rows) {
  return el("table", { class: "dense" },
    el("caption", { class: "sr-only", text: caption }),
    el("thead", {}, el("tr", {}, ...head.map((h) => el("th", { scope: "col", text: h })))),
    el("tbody", {}, ...rows.map((cells) => el("tr", {}, ...cells.map((c, i) => el("td", { class: i === 1 ? "val" : null, text: c }))))));
}

function headerRows(off, flen) {
  const b = state.bytes;
  const plen = b[off + 1];
  const msgid = b[off + 7] | (b[off + 8] << 8) | (b[off + 9] << 16);
  const signed = b[off + 2] & 1;
  const rows = [];
  if (state.result.format === "tlog" && off >= 8) {
    let us = 0;
    for (let i = 0; i < 8; i++) us = us * 256 + b[off - 8 + i];
    const iso = us >= 946684800e6 && us <= 4102444800e6 ? new Date(us / 1000).toISOString() : "not a plausible time";
    rows.push(["tlog timestamp", `${us} µs (${iso})`, "-8 to -1"]);
  }
  rows.push(["Start byte", hexN(b[off], 2), "0"], ["Payload length", String(plen), "1"],
    ["Incompat flags", `${hexN(b[off + 2], 2)}${signed ? " (signature present; not verified)" : ""}`, "2"], ["Compat flags", hexN(b[off + 3], 2), "3"],
    ["Sequence", String(b[off + 4]), "4"], ["System ID", String(b[off + 5]), "5"], ["Component ID", String(b[off + 6]), "6"],
    ["Message ID", `${msgid} (${msgLabel(msgid)})`, "7 to 9"]);
  let crcInfo = null;
  if (flen >= 12 + plen && off + 12 + plen <= b.length) {
    const c = 10 + plen;
    const received = b[off + c] | (b[off + c + 1] << 8);
    const computed = state.parser.crc(b.subarray(off, off + c + 2));
    crcInfo = { received, computed };
    rows.push(["CRC", `${hexN(received, 4)} received, ${computed === null ? "cannot be computed" : hexN(computed, 4) + " computed"}`, `${c} to ${c + 1}`]);
    if (signed) rows.push(["Signature", "signature present; not verified (13 bytes: link id, timestamp, hash)", `${c + 2} to ${c + 14}`]);
  }
  return { rows, crcInfo, plen, msgid };
}

function segments(off, plen, signed, flen) {
  const segs = [];
  if (state.result.format === "tlog" && off >= 8) segs.push({ from: off - 8, to: off, cls: "seg-ts", name: "tlog timestamp" });
  segs.push({ from: off, to: off + 10, cls: "seg-hdr", name: "header" });
  if (flen > 10) {
    segs.push({ from: off + 10, to: off + 10 + plen, cls: "seg-pay", name: "payload" });
    segs.push({ from: off + 10 + plen, to: off + 12 + plen, cls: "seg-crc", name: "CRC" });
    if (signed) segs.push({ from: off + 12 + plen, to: off + 25 + plen, cls: "seg-sig", name: "signature" });
  }
  return segs;
}

function renderDetail() {
  const r = state.result;
  const box = $("decoded");
  if (!r || !state.sel) {
    box.replaceChildren(el("p", { class: "muted pad", text: "Select a frame or an issue." }));
    $("hex").textContent = "Select a frame.";
    return;
  }
  let off;
  let flen;
  const kids = [];
  let issue = null;
  let frame = null;
  if (state.sel.t === "i") {
    issue = r.issues[state.sel.i];
    if (SEQ_KINDS.has(issue.kind)) frame = frameAt(r, issue.frame);
  } else {
    frame = frameAt(r, state.sel.i);
    issue = r.issues.find((it) => SEQ_KINDS.has(it.kind) && it.frame === state.sel.i) || null;
  }
  if (frame) {
    off = frame.off;
    flen = frame.flen;
    kids.push(el("p", { class: "lead" }, el("strong", { text: msgLabel(frame.msgid) }),
      ` (id ${frame.msgid}), frame ${fmt(frame.index + 1)}: ${flen} bytes at offset ${fmt(off)}` +
      (relTime(frame.ts) ? `, t = ${relTime(frame.ts)} s` : "")));
    if (frame.iflags & 1) {
      kids.push(el("p", { class: "note", text: "Signed frame: signature present; not verified. This inspector, like the parser, carries the 13 signature bytes without checking them (that needs the link's secret key)." }));
    }
    if (issue && SEQ_KINDS.has(issue.kind)) {
      const who = `System ${issue.sysid} component ${issue.compid}`;
      const text = issue.kind === "gap"
        ? `${who} went from seq ${issue.prevSeq} to ${issue.seq}. If its frames arrived in order, about ${issue.missing} ` +
          `frame${issue.missing === 1 ? " is" : "s are"} missing before this one. This is an estimate from sequence numbers ` +
          "(a late frame looks the same), not a CRC error; CRC errors are counted separately."
        : issue.kind === "duplicate"
          ? `${who} sent seq ${issue.seq} twice in a row (a duplicate or retransmitted frame). Not counted as missing.`
          : `${who} went back from seq ${issue.prevSeq} to ${issue.seq} (${issue.back} back). ` +
            (issue.reset ? "A step this large more likely means the sender restarted; counting continues from here."
              : "Most likely a late frame delivered out of order. Not counted as missing.");
      kids.push(el("p", { class: "note warn" }, el("span", { class: `kind ${issue.kind}`, text: `${ISSUE_TEXT[issue.kind]}. ` }), text));
    }
  } else {
    off = issue.off;
    flen = Math.min(issue.flen, r.byteLength - off);
    const what = issue.kind === "crc"
      ? "The header looked valid but the checksum over header and payload does not match, so the frame was discarded."
      : issue.kind === "unsupported"
        ? `Message id ${issue.msgid} is not in the common dialect (it may come from another dialect, such as ardupilotmega, or be noise). ` +
          "Without its CRC_EXTRA the checksum cannot be checked, so the frame is skipped as unsupported, not counted as corrupt."
        : `Incompat flags ${hexN(issue.iflags, 2)} include bits other than "signed", which this parser does not support.`;
    kids.push(el("p", { class: "lead" }, el("span", { class: `kind ${issue.kind}`, text: ISSUE_TEXT[issue.kind] }),
      ` at offset ${fmt(off)}` + (relTime(issue.ts) ? `, t = ${relTime(issue.ts)} s` : "")));
    kids.push(el("p", { class: `note ${issue.kind === "crc" ? "bad" : ""}`, text: what +
      " The parser then looked for the next 0xFD inside these bytes, so a valid frame hidden in them is still found." }));
  }
  const b = state.bytes;
  const signed = b[off + 2] & 1;
  const h = headerRows(off, flen);
  if (h.crcInfo && issue && issue.kind === "crc" && h.crcInfo.computed !== null) {
    kids.push(el("p", { class: "note bad", text: `CRC received ${hexN(h.crcInfo.received, 4)}, computed ${hexN(h.crcInfo.computed, 4)} ` +
      "by mavframe_crc16() in the WebAssembly module." }));
  }
  kids.push(el("h3", { text: "Header" }), table("Frame header fields", ["Field", "Value", "Bytes"], h.rows));
  if (frame) {
    const payload = b.subarray(off + 10, off + 10 + h.plen);
    const dec = decodePayload(frame.msgid, payload);
    if (dec) {
      kids.push(el("h3", { text: `Payload: ${dec.name}` }));
      kids.push(el("p", { class: "lead muted small", text: dec.description }));
      kids.push(table(`${dec.name} payload fields`, ["Field", "Value", "Units", "Reading"],
        dec.fields.map((f) => [f.name + (f.ext ? " (extension)" : ""), formatValue(f.value), f.units || "", f.meaning || ""])));
      if (dec.trimmed) kids.push(el("p", { class: "note", text: `The sender trimmed trailing zero bytes (MAVLink v2): ${h.plen} of ${dec.length} payload bytes were sent; the rest read as zero.` }));
    } else {
      kids.push(el("h3", { text: "Payload" }), el("p", { class: "note", text:
        `${h.plen} payload bytes, shown in the Bytes pane. Fields are decoded only for HEARTBEAT, SYS_STATUS, GPS_RAW_INT, ATTITUDE, GLOBAL_POSITION_INT and VFR_HUD.` }));
    }
  }
  box.replaceChildren(...kids);
  const end = Math.min(r.byteLength, off + flen);
  renderHex(r.format === "tlog" && off >= 8 ? off - 8 : off, end, segments(off, h.plen, signed, flen));
  $("hex").setAttribute("aria-label", `Bytes ${fmt(off)} to ${fmt(end - 1)} in hexadecimal`);
}

// ---------- URL state (only for the built-in sample, the one capture a link can reproduce) ----------
function writeHash() {
  if (!state.isSample) {
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    return;
  }
  const p = new URLSearchParams();
  p.set("view", state.view);
  if (state.msg !== null) p.set("msg", String(state.msg));
  if (state.sel) p.set("sel", state.sel.t + state.sel.i);
  history.replaceState(null, "", "#" + p.toString());
}

function applyHash(hash) {
  const r = state.result;
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  state.view = p.get("view") === "issues" ? "issues" : "frames";
  const msg = Number.parseInt(p.get("msg") ?? "", 10);
  state.msg = Number.isInteger(msg) && r.messages.some((m) => m.msgid === msg) ? msg : null;
  state.rows = null;
  const m = /^([fi])(\d{1,9})$/.exec(p.get("sel") || "");
  if (m) {
    const i = Number(m[2]);
    if ((m[1] === "f" && i < r.frameCount) || (m[1] === "i" && i < r.issues.length)) {
      state.sel = { t: m[1], i };
      const pos = listRows().indexOf(i);
      if (pos >= 0 && m[1] === (state.view === "frames" ? "f" : "i")) state.page = Math.floor(pos / PAGE);
    }
  }
}

// ---------- wiring ----------
function wire() {
  $("load-sample").addEventListener("click", async () => {
    state.pendingHash = null;
    await loadSample();
    // The button is disabled while loading, which drops keyboard focus; give it back.
    if (document.activeElement === document.body) $("load-sample").focus();
  });
  $("cancel").addEventListener("click", () => state.abort?.abort());
  $("file").addEventListener("change", (e) => { openFile(e.target.files[0]); e.target.value = ""; });
  $("format").addEventListener("change", () => { if (state.bytes) run(state.bytes, state.name, state.isSample); });
  $("view-frames").addEventListener("click", () => setView("frames"));
  $("view-issues").addEventListener("click", () => setView("issues"));
  $("clear-filter").addEventListener("click", () => setFilter(null));
  $("prev-page").addEventListener("click", () => { state.page--; renderList(); });
  $("next-page").addEventListener("click", () => { state.page++; renderList(); });
  $("prev-issue").addEventListener("click", () => stepIssue(-1));
  $("next-issue").addEventListener("click", () => stepIssue(1));
  $("timeline").addEventListener("click", onTimelineClick);
  let t = 0;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => state.result && renderTimeline(), 100); }).observe($("timeline"));
  for (const id of ["prev-issue", "next-issue", "prev-page", "next-page", "view-frames", "view-issues"]) $(id).disabled = true;
}

async function main() {
  wire();
  setBusy(true);
  try {
    state.parser = await loadParser("mavframe.wasm");
  } catch (err) {
    setStatus(`Could not load the parser (mavframe.wasm): ${err.message}`, true);
    return;
  }
  setBusy(false);
  for (const id of ["view-frames", "view-issues"]) $(id).disabled = false;
  state.pendingHash = location.hash || null;
  await loadSample();
}

main();
