// UI for the mavframe inspector: hash routes, the packet analyzer (frame list |
// field tree | bytes) and the finding export. Analysis lives in core.js (the
// C parser in WebAssembly), rows.js and anatomy.js; this file only renders.
// Everything taken from a capture is inserted with textContent.
import { loadParser, analyze, MAX_CAPTURE_BYTES } from "./core.js";
import { rowIndex, rowInfo, filterRows, issuePositions, CANDIDATE_KINDS } from "./rows.js";
import { anatomy, hexN, msgLabel } from "./anatomy.js";
import { buildFinding, MAVFRAME_VERSION } from "./finding.js";
import { buildCaptureReport, reportCsv, reportMarkdown } from "./capture-report.js";
import { wireSerial } from "./serial.js";
import { NAV_ICONS } from "./nav-icons.js";
import { getSession, getProfile, initLocalProfiles, signup, login, startGuest, logout, loadWorkspace, saveWorkspace, deleteWorkspace, loadPreferences, savePreferences, createEncryptedBackup, previewEncryptedBackup, commitEncryptedBackup, applyCloudCollection } from "./local-profile.js";
import { createSyncProvider } from "./sync-provider.js";
import { initPwa, acceptUpdate, shareTextOrFile } from "./pwa.js";
import { MAX_CUSTOM_XML_BYTES, parseCustomDialectXml } from "./custom-dialect.js";
import { buildLinkHealthTimeline } from "./link-health.js";

const SAMPLE = { url: "sample/sample-flight.tlog", name: "sample-flight.tlog" };
const PAGE = 100;
// Enlarged text gets the sequential view so viewport budgeting cannot erase the frame list.
const WIDE = window.matchMedia("(min-width: 1200px) and (min-height: 880px)");
const wideLayout = () => WIDE.matches && Number.parseFloat(getComputedStyle(document.documentElement).fontSize) < 24;
const CHECKS = ["all", "issues", "crc", "unsupported", "valid"];
const TABS = ["decoded", "bytes", "header"];
const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("en-US");

const state = {
  parser: null, result: null, bytes: null, name: "", isSample: false, busy: false, abort: null,
  original: null, sourceScope: null, customDialect: null,
  rowsKey: "", rows: null, lastScreen: null, lastHash: null, prevRoute: null, route: null, keepFocusNext: false,
};
let syncProvider = null;
let syncBoundProfileId = null;
const sessionCurrent = (nonce) => !!nonce && getSession()?.nonce === nonce;

function quickStorage(session) {
  const key = `mavframe_quickstart_v1_${session.id}`;
  const legacyKey = `mavframe:quickstart:v1:${session.id}`;
  return { store: session.mode === "profile" ? localStorage : sessionStorage, key, legacyKey };
}
function loadQuickStart(session = getSession()) {
  if (!session) return { steps: [false, false, false], dismissed: false };
  if (quickStartMemory.id === session.id) return quickStartMemory;
  quickStartMemory.id = session.id; quickStartMemory.steps = [false, false, false]; quickStartMemory.dismissed = false;
  try {
    const { store, key, legacyKey } = quickStorage(session); const value = store.getItem(key) ?? store.getItem(legacyKey);
    if (value && value.length <= 256) {
      const saved = JSON.parse(value);
      if (saved?.schema === 1 && saved.userId === session.id && Array.isArray(saved.steps) && saved.steps.length === 3 && saved.steps.every(step => typeof step === "boolean") && typeof saved.dismissed === "boolean") {
        quickStartMemory.steps = saved.steps; quickStartMemory.dismissed = saved.dismissed;
        if (store.getItem(key) === null) store.setItem(key, value);
      }
    }
  } catch { /* Optional checklist progress never blocks workspace use. */ }
  return quickStartMemory;
}
function saveQuickStart() {
  const session = getSession(); if (!session || quickStartMemory.id !== session.id) return;
  try {
    const { store, key, legacyKey } = quickStorage(session);
    store.setItem(key, JSON.stringify({ schema: 1, userId: session.id, steps: quickStartMemory.steps, dismissed: quickStartMemory.dismissed }));
    store.removeItem(legacyKey);
  } catch { const copy = $("quickstart-copy"); if (copy) copy.textContent = "Checklist progress stays in memory because browser storage is unavailable."; }
}
function renderQuickStart(session = getSession()) {
  const details = $("quickstart"); if (!details) return;
  const guest = session?.mode === "guest"; const profile = session?.mode === "profile";
  details.hidden = !session || loadQuickStart(session).dismissed;
  if (!guest && !profile) return;
  const labels = ["Load the synthetic sample", "Inspect a CRC/frame finding", "Export the finding"];
  for (const [index, item] of [...details.querySelectorAll("[data-quick-step]")].entries()) {
    const done = quickStartMemory.steps[index]; item.replaceChildren(document.createTextNode(`${index + 1}. ${labels[index]} — ${done ? "Complete" : "Not complete"}`));
    if (done) item.dataset.complete = "true"; else delete item.dataset.complete;
  }
  $("quickstart-copy").textContent = "Optional · progress is saved with this local profile or guest tab.";
}
function markQuickStep(index) {
  const session = getSession(); if (!session || index < 0 || index > 2) return;
  loadQuickStart(session); if (quickStartMemory.steps[index]) return;
  quickStartMemory.steps[index] = true; saveQuickStart(); renderQuickStart(session);
}

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

const timeMode = () => state.result && !state.result.timestampReversals && !Number.isNaN(state.result.firstTs) && state.result.endTs > state.result.firstTs;
function relTime(ts) {
  const r = state.result;
  if (!r || Number.isNaN(ts) || Number.isNaN(r.firstTs)) return "";
  return ((ts - r.firstTs) / 1e6).toFixed(3);
}

// ---------- routes ----------
// #/ is the product page; old workspace URLs remain explicit local-demo aliases.
function parseHash(hash) {
  if (!hash) {
    const product = ({ "/": "decoder", "/anomalies": "anomalies", "/stream": "stream", "/system": "system" })[location.pathname];
    if (product) {
      const q = new URLSearchParams(location.search);
      const target = product === "decoder" ? "capture" : product === "system" ? "system" : (product === "stream" || q.has("row")) && /^\d{1,9}$/.test(q.get("row") || "0") ? `frames/${q.get("row") || "0"}` : "frames";
      if (product === "anomalies" && !q.has("check")) q.set("check", "issues");
      if (product === "stream" && !q.has("tab")) q.set("tab", "bytes");
      const route = product === "system" ? { screen: "system", params: {}, workspace: true } : parseHash(`#/${target}?${q}`);
      return { ...route, product };
    }
  }
  if (!hash || hash === "#" || hash === "#/") return { screen: "landing", params: {} };
  if (/^#(view|msg|sel)=/.test(hash)) return { screen: "legacy", params: {}, workspace: true };
  if (!hash.startsWith("#/")) return { screen: "anchor", params: {} };
  let [path, query = ""] = hash.slice(2).split("?");
  if (["signup", "login", "profile", "saved"].includes(path)) {
    const q = new URLSearchParams(query);
    const candidate = q.get("return");
    internalReturn = candidate && /^#\/(?:app|capture|frames|help)(?:[/?][A-Za-z0-9_./?=&%-]*)?$/.test(candidate) && !candidate.includes("..") ? candidate : "#/app";
    return { screen: path, params: {}, workspace: false };
  }
  let appAlias = false;
  if (path === "app" || path.startsWith("app/")) {
    appAlias = true;
    path = path === "app" ? "capture" : path.slice(4);
  }
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
  if (path === "capture") return { screen: "capture", params, workspace: true, appAlias };
  if (path === "help") return { screen: "help", params, workspace: true, appAlias };
  if (path === "frames") return { screen: "frames", params, workspace: true, appAlias };
  const m = /^frames\/(\d{1,9})$/.exec(path);
  if (m) return { screen: "details", index: Number(m[1]), params, workspace: true, appAlias };
  return { screen: "notfound", params, workspace: true, appAlias };
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
  if (state.route?.product && ["frames", "details"].includes(screen)) {
    if (screen === "details") q.set("row", String(p.index));
    if (state.route.product === "anomalies" && p.check === "all") q.set("check", "all");
    return `${state.route.product === "stream" ? "/stream" : "/anomalies"}${q.size ? "?" + q : ""}`;
  }
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

const SCREENS = { capture: "screen-capture", frames: "screen-frames", details: "screen-details", help: "screen-help", notfound: "screen-notfound", system: "screen-system" };
const TITLES = { capture: "Capture", frames: "Frames", details: "Frame details", help: "Format help", notfound: "Not found", system: "Health and metrics" };
const PUBLIC_SCREENS = { landing: "screen-landing", signup: "screen-auth", login: "screen-auth", profile: "screen-profile", saved: "screen-saved" };
let internalReturn = "#/app";
let serialControls = null;
let workspaceEpoch = 0;
let lastWorkspaceContext = null;
let sampleAttemptSession = "";
let parserReady = null;
let pwa = null;
let heroSampleResult = null;
let pendingGuestSave = null;
let pendingCustomDialectFile = null;
let shareDraft = null;
let pendingExports = 0;
const quickStartMemory = { id: null, steps: [false, false, false], dismissed: false };

function ensureDemoSample() {
  const session = getSession();
  if (state.route?.screen === "system" || !state.parser || !session || session.mode !== "guest" || !state.route?.workspace || state.route.screen === "notfound" || state.result || state.busy || sampleAttemptSession === session.nonce) return;
  sampleAttemptSession = session.nonce;
  loadSample();
}

function renderPublic(route, { keepFocus = false } = {}) {
  if (["profile", "saved"].includes(route.screen) && !getSession()) {
    history.replaceState(null, "", "#/login");
    route = { screen: "login", params: {} };
  }
  const landing = route.screen === "landing";
  const auth = route.screen === "signup" || route.screen === "login";
  const session = getSession();
  if (syncBoundProfileId && session?.id !== syncBoundProfileId) disconnectCloudSync("Cloud connection ended because the local profile changed.");
  const target = PUBLIC_SCREENS[route.screen] || PUBLIC_SCREENS.landing;
  document.title = ({ landing: "Mavframe · MAVLink capture inspection", signup: "Create profile · Mavframe", login: "Log in · Mavframe", profile: "Profile · Mavframe", saved: "Saved workspaces · Mavframe" })[route.screen] || "Mavframe";
  $("public-shell").hidden = false;
  $("workspace-shell").hidden = true;
  for (const id of Object.values(PUBLIC_SCREENS)) $(id).hidden = id !== target;
  $("screen-landing").hidden = !landing;
  $("screen-auth").hidden = !auth;
  $("auth-title").textContent = route.screen === "login" ? "Log in on this browser" : "Create a local profile";
  $("auth-side-title").textContent = route.screen === "login" ? "Return to your saved inspection settings." : "A local profile for your inspection settings.";
  $("auth-explainer").textContent = "Profiles are stored only in this browser. They do not verify identity, sync, encrypt captures or provide remote recovery.";
  $("auth-submit").textContent = route.screen === "login" ? "Log in" : "Create profile";
  $("auth-password").autocomplete = route.screen === "login" ? "current-password" : "new-password";
  $("auth-switch").href = route.screen === "login" ? "#/signup" : "#/login";
  $("auth-switch").href += `?return=${encodeURIComponent(internalReturn)}`;
  $("auth-switch").textContent = route.screen === "login" ? "Create a local profile" : "Already have a profile? Log in";
  $("public-account").hidden = session?.mode !== "profile";
  $("public-account-label").textContent = session?.mode === "profile" ? (getProfile()?.email || "Local profile") : "Profile";
  $("profile-sync").hidden = session?.mode !== "profile";
  $("backup-export").disabled = session?.mode !== "profile";
  const returnLink = $("auth-return");
  returnLink.href = pendingGuestSave?.returnHash || internalReturn || "#/";
  returnLink.textContent = pendingGuestSave ? "← Return to guest task" : "← Home";
  $("auth-pending-save").hidden = !pendingGuestSave;
  if (pendingGuestSave) $("auth-pending-save").textContent = "You chose to save this guest view. After signing in, confirm to save only its filters, selection and theme; capture bytes stay in this tab and are not imported.";
  $("auth-error").hidden = true; $("auth-status").textContent = "";
  if (route.screen === "profile") {
    const profile = getProfile();
    $("profile-email").textContent = session?.mode === "guest" ? "Demo session. No profile is signed in." : (profile?.email || "Profile details are unavailable in browser storage.");
    $("save-context-form").hidden = session?.mode !== "profile";
    $("profile-pending-import").hidden = !pendingGuestSave || session?.mode !== "profile";
    $("import-pending-save").hidden = !pendingGuestSave || session?.mode !== "profile";
    $("profile-error").hidden = true; $("profile-status").textContent = "";
  }
  if (route.screen === "saved") renderSavedWorkspaces();
  const heading = $(route.screen === "signup" || route.screen === "login" ? "auth-title" : ({ landing: "landing-title", profile: "profile-title", saved: "saved-title" })[route.screen]);
  if (state.lastScreen !== null && state.lastScreen !== route.screen && !keepFocus) requestAnimationFrame(() => heading?.focus());
  state.lastScreen = route.screen; state.lastHash = location.hash; state.route = route;
}

function disconnectCloudSync(message = "Cloud connection ended.") {
  syncProvider?.logout(); syncProvider = null; syncBoundProfileId = null;
  if ($("sync-now")) $("sync-now").disabled = true;
  if ($("sync-status")) $("sync-status").textContent = message;
}

function renderSavedWorkspaces() {
  const session = getSession(); const region = $("saved-list");
  region.replaceChildren();
  if (session?.mode !== "profile") {
    region.append(el("p", { text: "Sign in to a local profile to save view settings." }), el("a", { href: "#/signup", class: "btn primary", text: "Create profile" }));
    return;
  }
  let workspaces;
  try { workspaces = loadWorkspace() || []; }
  catch (error) { region.append(el("p", { role: "alert", text: error.message })); return; }
  if (!workspaces.length) { region.append(el("p", { text: "No saved views yet. Save filters and view settings from Profile." })); return; }
  const list = el("ul", { class: "saved-list" });
  for (const workspace of workspaces) {
    const button = el("button", { type: "button", class: "btn", text: `Open ${workspace.name}` });
    button.addEventListener("click", () => {
      applyTheme(workspace.theme === "dark");
      const c = workspace.context;
      const params = { check: c.check, msg: c.msg, page: c.page, tab: c.tab, f: c.field, index: c.index };
      try { savePreferences({ theme: workspace.theme }); }
      catch { setStatus("View opened, but the profile theme preference could not be saved.", true); }
      navigate(buildHash(c.screen === "details" && c.index == null ? "frames" : c.screen, params));
    });
    const remove = el("button", { type: "button", class: "btn delete-view", "aria-label": `Delete saved view ${workspace.name}`, text: "Delete" });
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete the saved view “${workspace.name}” from this browser?`)) return;
      try {
        await deleteWorkspace(workspace.name);
        renderSavedWorkspaces();
        $("saved-list").querySelector(".delete-view")?.focus() || $("saved-title").focus();
      } catch (error) { region.prepend(el("p", { role: "alert", text: error.message })); }
    });
    const actions = el("div", { class: "saved-actions" }, button, remove);
    list.append(el("li", {}, el("div", {}, el("strong", { text: workspace.name }), el("p", { class: "muted small", text: `Saved ${new Date(workspace.savedAt).toLocaleString()}; filters and view only.` })), actions));
  }
  region.append(list);
}

function currentSafeContext() {
  if (state.route?.screen === "landing" && heroSampleResult) return { screen: "details", check: "crc", tab: "decoded", index: heroSampleResult.rowPosition };
  if (["profile", "saved", "login", "signup", "landing"].includes(state.route?.screen)) return lastWorkspaceContext || { screen: "capture" };
  const route = state.route || { screen: "capture", params: {} };
  return { screen: route.screen, check: route.params?.check, msg: route.params?.msg, page: route.params?.page, tab: route.params?.tab, field: route.params?.f, index: route.index };
}

function render({ keepFocus = false } = {}) {
  if (state.keepFocusNext) { keepFocus = true; state.keepFocusNext = false; }
  const route = parseHash(location.hash);
  if (route.screen === "anchor") return;
  if (["landing", "signup", "login", "profile", "saved"].includes(route.screen)) { renderPublic(route, { keepFocus }); return; }
  if (!getSession()) {
    try { startGuest(); }
    catch (error) { history.replaceState(null, "", "#/"); renderPublic({ screen: "landing" }); return; }
  }
  const activeSession = getSession();
  if (syncBoundProfileId && activeSession?.id !== syncBoundProfileId) disconnectCloudSync("Cloud connection ended because the local profile changed.");
  if (route.workspace) lastWorkspaceContext = { screen: route.screen, check: route.params?.check, msg: route.params?.msg, page: route.params?.page, tab: route.params?.tab, field: route.params?.f, index: route.index };
  $("public-shell").hidden = true;
  $("workspace-shell").hidden = false;
  if (route.screen === "legacy") {
    if (state.result) { history.replaceState(null, "", legacyTarget(location.hash)); render(); return; }
    route.screen = "frames"; // shown as loading until the sample is parsed
  }
  if (state.route && location.hash !== state.lastHash) state.prevRoute = state.route;
  state.route = route;
  state.lastHash = location.hash;
  const wide = wideLayout();
  const screen = route.screen === "details" && wide ? "frames" : route.screen;
  for (const [name, id] of Object.entries(SCREENS)) $(id).hidden = name !== screen;

  // On wide screens a selected row stays on the Frames screen (the analyzer), so title, H1 and
  // breadcrumb say Frames; on narrow screens #/frames/<row> is its own Frame details screen.
  const shown = route.screen === "details" && wide ? "frames" : route.screen;
  const productTitle = ({ decoder: "MAVLink frame decoder", anomalies: "Anomaly analysis", stream: "Hex / binary comparison", system: "Health and metrics" })[route.product];
  document.title = `${productTitle || TITLES[shown]} – Mavframe`;
  for (const [name, id] of Object.entries(SCREENS)) $(id).querySelector("h1").textContent = name === screen && productTitle ? productTitle : TITLES[name];
  document.body.classList.toggle("product-mode", !!route.product);
  $("product-note").hidden = !["anomalies", "stream"].includes(route.product);
  $("product-note").textContent = route.product === "anomalies" ? "CRC and sequence findings only. Control-state anomaly detection is unavailable. Gap estimates assume a fully observed channel and in-order arrival." : "Compare decoded fields, wire bytes and received/computed CRC for the selected packet.";
  for (const link of document.querySelectorAll("[data-product-route]")) {
    if (link.dataset.productRoute === route.product) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  const session = getSession();
  $("account-label").textContent = session?.mode === "profile" ? (getProfile()?.email || "Local profile") : "Guest demo";
  $("profile-link").textContent = session?.mode === "profile" ? "Profile" : "Save to profile";
  $("profile-link").href = session?.mode === "profile" ? "#/profile" : "#/signup";
  $("saved-link").hidden = session?.mode !== "profile";
  $("save-profile-link").hidden = session?.mode !== "guest";
  $("public-account").hidden = session?.mode !== "profile";
  $("workspace-account").hidden = session?.mode !== "profile";
  $("public-account-label").textContent = session?.mode === "profile" ? (getProfile()?.email || "Local profile") : "Profile";
  $("workspace-account-label").textContent = session?.mode === "profile" ? (getProfile()?.email || "Local profile") : "Profile";
  renderQuickStart(session);
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

  if (screen === "system" && state.lastScreen !== "system") refreshSystem();
  if (screen === "capture") renderCapture();
  if (screen === "frames") renderFrames(route);
  if (screen === "details") renderDetailsScreen(route);
  if (productTitle) $(SCREENS[screen]).querySelector("h1").textContent = productTitle;

  const changed = state.lastScreen !== null && state.lastScreen !== screen;
  const first = state.lastScreen === null;
  state.lastScreen = screen;
  if (!first && (changed || !keepFocus)) {
    if (changed) window.scrollTo(0, 0);
    $(SCREENS[screen]).querySelector("h1").focus();
  }
  ensureDemoSample();
}

async function refreshSystem() {
  const button = $("refresh-system"); if (button.disabled) return;
  button.disabled = true;
  $("system-status").textContent = "Checking service…";
  const endpoints = [["/healthz", "Liveness"], ["/readyz", "Readiness"], ["/api/system", "HTTP process"], ["/metrics", "Prometheus metrics"]];
  const results = await Promise.all(endpoints.map(async ([url, label]) => {
    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (url === "/metrics") {
        if (!body.includes("# TYPE")) throw new Error("Metrics response is not Prometheus text");
        $("system-metrics").textContent = body;
      } else {
        const value = JSON.parse(body);
        if (url === "/api/system") {
          const items = [["Service", value.service], ["Status", value.status], ["Uptime (seconds)", value.uptime_seconds], ["HTTP requests", value.http?.requests_total], ["HTTP errors", value.http?.errors_total]];
          $("system-values").replaceChildren(...items.map(([name, val]) => el("div", {}, el("dt", {text:name}), el("dd", {text:val ?? "Unavailable"}))));
          $("system-scope").textContent = value.scope || "HTTP serving process; browser parsing is not measured.";
        }
      }
      return el("li", {text:`${label}: available (HTTP ${response.status})`});
    } catch (error) {
      if (url === "/api/system") $("system-values").replaceChildren();
      if (url === "/metrics") $("system-metrics").textContent = "Metrics unavailable.";
      return el("li", {class:"system-failure", text:`${label}: unavailable (${error.name === "TimeoutError" ? "timed out" : error.message}).`});
    }
  }));
  $("system-checks").replaceChildren(...results);
  $("system-status").textContent = results.some(item => item.classList.contains("system-failure")) ? "Some service data is unavailable. Retry or check the serving process." : `Checked ${new Date().toLocaleTimeString()}.`;
  button.disabled = false;
}

// ---------- loading ----------
async function loadCustomDialect(file, includeFiles = []) {
  const output = $('custom-dialect-status');
  if (!file) return;
  if (file.size > MAX_CUSTOM_XML_BYTES || includeFiles.some(item => item.size > MAX_CUSTOM_XML_BYTES) || file.size + includeFiles.reduce((sum, item) => sum + item.size, 0) > 4 * MAX_CUSTOM_XML_BYTES) { output.textContent = 'Selected XML files exceed the 1 MiB per-file or 4 MiB combined safety limit.'; return; }
  if (!state.parser || state.busy) { output.textContent = 'Wait until the parser is ready and the current analysis finishes.'; return; }
  try {
    const source = await file.text();
    const sources = new Map();
    for (const include of includeFiles) {
      if (sources.has(include.name) || include.name === file.name) throw new Error(`Selected XML files contain a duplicate filename: ${include.name}`);
      sources.set(include.name, await include.text());
    }
    if (state.busy) throw new Error('The current analysis started while the XML was being read. Wait and retry.');
    const previous = state.customDialect;
    const dialect = parseCustomDialectXml(source, undefined, { entryName: file.name, sources });
    if (!state.parser.setCustomExtras(dialect.pairs)) throw new Error('The C/Wasm parser rejected the message-ID table.');
    state.customDialect = dialect;
  $('custom-dialect-name').textContent = `${file.name} · ${dialect.messageCount} custom messages · ${dialect.fieldCount} fields · ${dialect.includedFiles.length} local includes · ${dialect.includedBuiltins.length} pinned built-ins confirmed · current tab only`;
    $('clear-custom-dialect').disabled = false;
    if (state.bytes) {
      output.textContent = 'Rechecking the current capture with the C/Wasm parser and this dialect…';
      const accepted = await run(state.bytes, state.name, state.isSample);
      if (!accepted) {
        state.customDialect = previous;
        state.parser.setCustomExtras(previous?.pairs || new Uint32Array());
        throw new Error('The current capture could not be rechecked; the previous dialect was restored. See the capture status.');
      }
      output.textContent = `Rechecked ${state.name} with ${dialect.messageCount} custom definitions and ${dialect.includedBuiltins.length} matching pinned built-ins. CRC validation comes from the C/Wasm parser.`;
    } else output.textContent = `Loaded ${dialect.messageCount} custom definitions and verified ${dialect.includedBuiltins.length} pinned built-ins. Frame and CRC checks use the C/Wasm parser.`;
  } catch (error) {
    output.textContent = `Custom dialect not loaded: ${error.message}`;
    $('custom-dialect-status').dataset.state = 'error';
  }
}

function clearCustomDialect() {
  if (state.busy) return;
  pendingCustomDialectFile = null;
  $('custom-dialect-file').value = ''; $('custom-dialect-includes').value = '';
  state.customDialect = null;
  state.parser?.setCustomExtras(new Uint32Array());
  $('custom-dialect-name').textContent = 'No custom dialect loaded. Maximum 1 MiB per file, 4 MiB combined; 512 custom messages.';
  $('clear-custom-dialect').disabled = true;
  $('custom-dialect-status').textContent = 'Cleared from this tab. Custom definitions are not saved.';
  if (state.bytes) run(state.bytes, state.name, state.isSample).then(ok => { if (ok) $('custom-dialect-status').textContent = 'Capture rechecked with the pinned common/ArduPilotMega definitions only.'; });
}

function setBusy(busy, cancellable = false) {
  state.busy = busy;
  for (const id of ["load-sample", "file", "format", "custom-dialect-file", "custom-dialect-includes", "clear-custom-dialect", "print-report", "print-report-detail"]) {
    const control = $(id); if (!control) continue;
    control.disabled = busy || (id === 'clear-custom-dialect' && !state.customDialect) || (id.startsWith('print-report') && !state.bytes);
  }
  for (const control of document.querySelectorAll('[data-capture-export], #export-finding, #mutate-byte, #restore-capture')) control.disabled = busy;
  for (const button of document.querySelectorAll('[data-capture-export]')) button.disabled = busy || !state.bytes;
  $("cancel").hidden = !(busy && cancellable);
}

async function run(bytes, name, isSample) {
  if (state.busy) return;
  const sessionNonce = getSession()?.nonce;
  const epoch = workspaceEpoch;
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
      customDialect: state.customDialect,
      signal: state.abort.signal,
      onProgress(done, total) {
        progress.value = total ? Math.round((100 * done) / total) : 100;
        ptext.textContent = `${mb(done)} of ${mb(total)} MB`;
      },
    });
    progress.value = 100;
    await yieldToBrowser();
    if (state.abort.signal.aborted || epoch !== workspaceEpoch || !sessionCurrent(sessionNonce)) throw new DOMException("parsing cancelled", "AbortError");
    Object.assign(state, { result, bytes, name, isSample, anatomy: null, rows: null, rowsKey: "" });
    fillMessageFilter();
    if (result.validFrames === 0) {
      setStatus(`No supported MAVLink frames found in ${name}: ${fmt(result.skippedBytes)} of ${fmt(bytes.length)} bytes skipped` +
        (result.unsupported ? `, ${fmt(result.unsupported)} candidates with message ids outside the pinned dialects` : "") +
        ". Open a .tlog or raw MAVLink v1/v2 capture.", true);
    } else {
      setStatus(`${name} loaded.`);
    }
    render({ keepFocus: true });
    return true;
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
  const sessionNonce = getSession()?.nonce;
  const epoch = workspaceEpoch;
  setBusy(true);
  setStatus(`Loading ${SAMPLE.name}…`);
  let bytes; let failed = false;
  try {
    const resp = await fetch(SAMPLE.url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    bytes = new Uint8Array(await resp.arrayBuffer());
    if (epoch !== workspaceEpoch || !sessionCurrent(sessionNonce)) return;
  } catch (err) {
    if (epoch !== workspaceEpoch || !sessionCurrent(sessionNonce)) return;
    setStatus(`Could not load the sample: ${err.message}`, true);
    failed = true;
  } finally {
    setBusy(false);
  }
  if (failed) { render({ keepFocus: true }); return; }
  if (await run(bytes, SAMPLE.name, true)) { state.original = { bytes, name: SAMPLE.name, isSample: true }; state.sourceScope = null; markQuickStep(0); }
}

async function openFile(file) {
  if (!file) return;
  const sessionNonce = getSession()?.nonce;
  const epoch = workspaceEpoch;
  if (file.size === 0) {
    setStatus(`${file.name} is empty (0 bytes). Choose a .tlog or raw MAVLink v1/v2 capture.`, true);
    return;
  }
  if (file.size > MAX_CAPTURE_BYTES) {
    setStatus(`${file.name} is ${(file.size / 1048576).toFixed(0)} MB; browser limit is ${MAX_CAPTURE_BYTES / 1048576} MB. Split the file or use mavframe-dump.`, true);
    return;
  }
  if (state.busy) return;
  setBusy(true);
  setStatus(`Reading ${file.name}…`);
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    if (epoch !== workspaceEpoch || !sessionCurrent(sessionNonce)) return;
  } catch (err) {
    setStatus(`Could not read ${file.name}: ${err.message}`, true);
    return;
  } finally {
    setBusy(false);
  }
  if (await run(bytes, file.name, false)) { state.original = { bytes, name: file.name, isSample: false }; state.sourceScope = null; }
}

// ---------- Capture ----------
function renderCapture() {
  for (const button of document.querySelectorAll('[data-capture-export]')) button.disabled = !state.bytes || state.busy;
  const r = state.result;
  $("capture-result").hidden = !r;
  if (!r) return;
  const s = $("source");
  s.replaceChildren(el("span", { class: "mono", text: state.name }),
    el("span", { text: `${fmt(state.bytes.length)} bytes, read as ${r.format === "tlog" ? ".tlog" : "raw stream"}` }));
  if (state.isSample) {
    s.append(el("span", { class: "label warn", text: "Synthetic sample; not a real flight" }));
  }
  if (state.sourceScope) s.append(el('span', { class: 'label warn', text: state.sourceScope }));
  $("capture-export-status").textContent = r.sourceGroupsTruncated ? "Detail grouping capped at 10,000 groups; global totals include all frames." : "Capture reports omit payloads; sequence gaps are estimates.";
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
  $("view-frames").textContent = `Inspect ${fmt(rowIndex(r).length)} frames`;
  renderMessages();
}

function renderMessages() {
  const r = state.result;
  const hz = (v) => (Number.isNaN(v) || r.timestampReversals ? "n/a" : v.toFixed(2));
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
  if (!rows.length) rows.push(el("tr", {}, el("td", { colspan: 6, class: "muted", text: "No valid MAVLink frames in this capture." })));
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
      el("p", {}, el("a", { class: "btn", href: "#/capture", text: "Capture" })));
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
    ...(state.isSample ? [el("span", { class: "label warn", text: "Synthetic sample; not a real flight" })] : []),
    c(r.validFrames, "valid frames"), c(r.crcErrors, "CRC failures"), c(r.unsupported, "unsupported"),
    c(r.gaps, "sequence gaps"), c(r.skippedBytes, "skipped bytes"));
  for (const b of document.querySelectorAll(".chip")) b.setAttribute("aria-pressed", String(b.dataset.check === p.check));
  $("msg-filter").value = p.msg === null ? "" : String(p.msg);
  $("clear-filters").hidden = p.check === "all" && p.msg === null;

  const rows = currentRows(p);
  if (p.check === "crc" && rows.length > 0) markQuickStep(1);
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
function xOf(ts, off, frameIndex = null) {
  const r = state.result;
  if (timeMode() && !Number.isNaN(ts)) return (ts - r.firstTs) / (r.endTs - r.firstTs);
  if (frameIndex !== null && Number.isFinite(frameIndex)) return r.frameCount ? frameIndex / r.frameCount : 0;
  return r.byteLength ? off / r.byteLength : 0;
}

function densityBins(count) {
  const r = state.result;
  if (r.bins && r.bins.length === count) return r.bins;
  const bins = new Uint32Array(count);
  const useTime = timeMode();
  const { ts, off } = r.frames;
  const span = useTime ? r.endTs - r.firstTs : r.frameCount || 1;
  for (let i = 0; i < r.frameCount; i++) {
    const v = useTime && !Number.isNaN(ts[i]) ? (ts[i] - r.firstTs) / span : i / (r.frameCount || 1);
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
    const x = (xOf(it.ts, it.off, it.frame) * (w - 8) + 4).toFixed(1);
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
      const x = (xOf(info.ts, info.off, info.frame?.index ?? null) * (w - 8) + 4).toFixed(1);
      kids.push(svgEl("line", { class: "cursor", x1: x, x2: x, y1: 0, y2: h }));
    }
  }
  svg.replaceChildren(...kids);
  const span = timeMode() ? `${((r.endTs - r.firstTs) / 1e6).toFixed(1)} seconds` : `${fmt(r.validFrames)} frame indices`;
  $("timeline-desc").textContent = `Timeline over ${span}: ${fmt(r.validFrames)} valid frames, ${fmt(r.crcErrors)} CRC failures, ${fmt(r.unsupported)} unsupported message ids, ` +
    `${fmt(r.gaps)} sequence gaps, ${fmt(r.duplicates + r.reorders)} duplicate or out-of-order sequence numbers. Use Previous issue and Next issue to step through them.`;
  $("axis-start").textContent = timeMode() ? "0 s" : "0";
  $("axis-unit").textContent = timeMode() ? "untrusted .tlog record time since first frame" : "frame index (no usable monotonic record timestamps)";
  $("axis-end").textContent = timeMode() ? `${((r.endTs - r.firstTs) / 1e6).toFixed(1)} s` : fmt(r.validFrames);
  const health = buildLinkHealthTimeline(r);
  $("link-health-axis").textContent = `Axis: ${health.axis}. Rates are valid parser frames per interval, not a radio arrival-rate measurement.`;
  const frameRows = rowIndex(r);
  $("link-health-rows").replaceChildren(...health.bins.map(bin => {
    const interval = health.timeBasis === "tlog-record-time" ? `${bin.start.toFixed(2)}–${bin.end.toFixed(2)} s` : `${fmt(bin.start)}–${fmt(bin.end)}`;
    const pos = bin.firstFrame === null ? -1 : frameRows.positionOf({ t: "f", i: bin.firstFrame });
    const intervalCell = pos >= 0
      ? el("a", { href: buildHash("details", { ...state.route.params, index: pos, tab: "decoded", f: null }), text: `${interval} · ${bin.firstFrame + 1}–${bin.lastFrame + 1}`, "aria-label": `Open ${interval}, retained frame indexes ${bin.firstFrame + 1} through ${bin.lastFrame + 1}` })
      : el("span", { text: `${interval} · no retained valid frame` });
    return el("tr", {}, el("th", { scope: "row", class: "mono" }, intervalCell),
      el("td", { class: "num", text: fmt(bin.validFrames) }), el("td", { class: "num", text: fmt(bin.crcFailures) }),
      el("td", { class: "num", text: fmt(bin.unsupportedFrames) }), el("td", { class: "num", text: fmt(bin.sequenceDiscontinuities) }),
      el("td", { class: "num", text: fmt(bin.missingEstimate) }), el("td", { class: "num", text: fmt(bin.timestampReversals) }),
      el("td", { class: "mono", text: `${bin.senders.join(", ") || "none"}${bin.sendersOmitted ? `; +${bin.sendersOmitted}` : ""}` }),
      el("td", { class: "num", text: bin.messageRateHz === null ? "unavailable" : bin.messageRateHz.toFixed(2) }));
  }));
  $("link-health-limitations").textContent = `Retained events: ${fmt(health.retained.crcFailures)} CRC failures, ${fmt(health.retained.unsupportedFrames)} unsupported IDs and ${fmt(health.retained.sequenceDiscontinuities)} sequence changes. Omitted details: ${fmt(health.omitted.crcFailures)} CRC, ${fmt(health.omitted.unsupportedFrames)} unsupported and ${fmt(health.omitted.sequenceDiscontinuities)} sequence events. Total parser timestamp reversals: ${fmt(health.timestampReversals)}. Sequence changes do not prove RF loss.`;
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
    const d = Math.abs((xOf(it.ts, it.off, it.frame) - fx) * rect.width);
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
    if (xOf(r.frames.ts[mid], r.frames.off[mid], mid) < fx) lo = mid + 1; else hi = mid;
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
      : el("p", { class: "muted", text: "No frame selected." }));
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
  if (info.check === "unsupported") notes.push(el("p", { class: "note", text: `Message id ${info.msgid} is outside the pinned common/ArduPilot definitions (it may be a custom dialect or noise). Without its CRC_EXTRA the checksum cannot be checked, so it is unsupported, not counted as corrupt.` }));
  if (info.check === "reject") notes.push(el("p", { class: "note", text: `Incompat flags ${hexN(info.iflags, 2)} include bits other than "signed", which this parser does not support.` }));
  $("detail-notes").replaceChildren(...notes);

  // Under the H1 on the narrow details screen the groups are h2; under the detail h2 in the analyzer, h3.
  const hTag = wide ? "h3" : "h2";
  const fieldsTable = (g, fields, caption) => el("div", { class: "table-wrap" }, el("table", { class: "dense" },
    el("caption", { class: "sr-only", text: caption }),
    el("thead", {}, el("tr", {}, ...["Field", "Value", "Reading", "Bytes"].map((h) => el("th", { scope: "col", text: h })))),
    el("tbody", {}, ...fields.map((f) => el("tr", { class: f.trimmed ? "trimmed" : null },
      el("td", {}, el("button", { type: "button", class: "fieldbtn", "data-key": f.key, "aria-pressed": "false", onclick: () => selectField(f.key, true) }, f.name)),
      el("td", { class: /^0x/.test(f.value) ? "val mono" : "val", text: f.value + (f.units ? ` ${f.units}` : "") }),
      el("td", { text: f.trimmed ? [f.reading, `${f.wireBytes} wire bytes; remaining bytes reconstructed as zero`].filter(Boolean).join("; ") : f.reading }),
      el("td", { class: "bytes", text: byteRange(f.from - a.off, f.to - 1 - a.off) }))))));
  const groupTable = (g) => {
    const kids = [el(hTag, { text: g.title })];
    if (g.description) kids.push(el("p", { class: "muted small", text: g.description }));
    if (g.fields.length) {
      if (wide && g.id === "header" && g.fields.length > 4) {
        const split = Math.ceil(g.fields.length / 2);
        kids.push(el("div", { class: "header-field-grid" },
          fieldsTable(g, g.fields.slice(0, split), `${g.title} fields, first half`),
          fieldsTable(g, g.fields.slice(split), `${g.title} fields, second half`)));
      } else kids.push(fieldsTable(g, g.fields, `${g.title} fields`));
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
    const from = g.id === "payload" ? a.off + a.hlen : Math.min(...g.fields.map((f) => f.from));
    const to = g.id === "payload" ? a.off + a.hlen + a.plen : Math.max(...g.fields.map((f) => f.to));
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
  $("mutation-offset").value = String(o);
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
  const snapshot = state.result;
  if (!snapshot || state.busy) return;
  const route = state.route;
  const ref = rowIndex(snapshot).at(route.index);
  if (!ref) return;
  const includeAll = $("include-payload").checked;
  const f = await buildFinding({ result: snapshot, bytes: state.bytes, parser: state.parser, ref, fileName: state.name,
    isSample: state.isSample, includeAllPayloads: includeAll });
  if (state.result !== snapshot) throw new Error('The capture changed before export. Export the current finding again.');
  const base = f.file.name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.[^.]*$/, "") || "capture";
  const file = `mavframe-finding-${base}-offset-${f.finding.offset}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(f, null, 2) + "\n"], { type: "application/json" }));
  const a = el("a", { href: url, download: file, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("export-status").textContent = `Exported ${file}: ${f.bytes.payload_hex !== undefined ? "includes the payload bytes" : "payload bytes left out (may carry GPS/position data)"}` +
    (f.file.sha256 ? "." : "; SHA-256 unavailable outside a secure context.");
  markQuickStep(2);
}

function showSharePreview(draft) {
  shareDraft = draft;
  $("share-title").textContent = draft.kind === "finding" ? "Review finding before sharing" : "Review report text before sharing";
  $("share-disclosure").textContent = draft.kind === "finding"
    ? "This JSON includes the capture name and selected finding. Payload bytes appear only if you selected Include all payloads. The original capture is not included."
    : "This report text includes the capture filename, summary counts and parser assumptions, not the capture bytes. Review it before sending.";
  $("share-preview").textContent = draft.text;
  $("share-status").textContent = "";
  $("confirm-share").disabled = false;
  $("share-dialog").showModal();
  $("cancel-share").focus();
}

async function prepareFindingShare() {
  if (!state.result || state.busy) { setStatus("Load and select a frame before sharing a finding.", true); return; }
  const snapshot = state.result; const route = state.route; const ref = rowIndex(snapshot).at(route.index);
  if (!ref) { setStatus("Select a frame or finding before sharing.", true); return; }
  pendingExports++;
  const button = $("share-finding"); button.disabled = true;
  try {
    const finding = await buildFinding({ result: snapshot, bytes: state.bytes, parser: state.parser, ref, fileName: state.name, isSample: state.isSample, includeAllPayloads: $("include-payload").checked });
    if (state.result !== snapshot) throw new Error("The capture changed before sharing. Select the current finding again.");
    const name = `mavframe-finding-${state.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60)}.json`;
    const text = JSON.stringify(finding, null, 2) + "\n";
    const file = typeof File === "function" ? new File([text], name, { type: "application/json" }) : null;
    showSharePreview({ kind: "finding", title: "Mavframe finding", text, file, name });
  } catch (error) { $("export-status").textContent = `Could not prepare the finding: ${error.message}`; }
  finally { pendingExports--; button.disabled = false; }
}

async function prepareReportShare() {
  if (!state.result || state.busy) { setStatus("Load a capture before sharing a report.", true); return; }
  const snapshot = state.result; pendingExports++;
  const button = $("share-report"); button.disabled = true;
  try {
    const report = await buildCaptureReport({ result: snapshot, bytes: state.bytes, fileName: state.name, isSample: state.isSample, source: state.sourceScope, customDialectName: state.customDialect?.name || null, selection: reportSelection() });
    if (state.result !== snapshot) throw new Error("The capture changed before sharing. Try again.");
    showSharePreview({ kind: "report", title: "Mavframe capture summary", text: reportMarkdown(report), file: null });
  } catch (error) { $("capture-export-status").textContent = `Could not prepare report text: ${error.message}`; }
  finally { pendingExports--; button.disabled = false; }
}

async function completeShare() {
  if (!shareDraft) return;
  const result = await shareTextOrFile(shareDraft);
  if (result.method === "native") $("share-status").textContent = "The share sheet closed. Delivery is controlled by the app you chose; Mavframe cannot verify that it was sent.";
  else if (result.method === "cancelled") $("share-status").textContent = "Share cancelled. Nothing was sent.";
  else if (result.method === "clipboard") $("share-status").textContent = "Copied to the clipboard. Choose where to paste it.";
  else $("share-status").textContent = "Sharing and clipboard access are unavailable. Use Export finding/report to save a file, or select the preview text manually.";
}

function reportSelection() {
  if (!state.result || state.route?.screen !== "details" || !Number.isSafeInteger(state.route.index)) return null;
  const ref = rowIndex(state.result).at(state.route.index); if (!ref) return null;
  const info = rowInfo(state.result, ref);
  return { row_index: state.route.index, source_offset: info.off, kind: info.check, message_id: info.msgid,
    system_id: info.sysid, component_id: info.compid, sequence: info.seq, field: state.route.params?.f || null };
}

async function exportCapture(format) {
  if (!state.result || state.busy) return;
  const snapshot = state.result;
  const report = await buildCaptureReport({ result: snapshot, bytes: state.bytes, fileName: state.name, isSample: state.isSample, source: state.sourceScope, customDialectName: state.customDialect?.name || null, selection: reportSelection() });
  if (state.result !== snapshot) throw new Error('Capture changed before export. Try again.');
  const text = format === 'json' ? JSON.stringify(report, null, 2) + '\n' : format === 'csv' ? reportCsv(report) : reportMarkdown(report);
  const blob = new Blob([text], { type: ({ json: 'application/json', csv: 'text/csv', md: 'text/markdown' })[format] });
  if (blob.size > 64 * 1024 * 1024) throw new Error('Report exceeds the 64 MiB export limit. Use the native CLI for this capture.');
  const url = URL.createObjectURL(blob);
  const name = state.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'capture';
  const link = el('a', { href: url, download: `mavframe-${name}-report.${format}`, hidden: true });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('capture-export-status').textContent = `Downloaded ${format.toUpperCase()} report for ${fmt(report.summary.valid_frames)} valid frames. No raw payloads were included.`;
}

async function printCaptureReport() {
  if (!state.result || state.busy) return;
  const snapshot = state.result; const opener = document.activeElement?.matches('#print-report, #print-report-detail') ? document.activeElement : $('print-report'); opener.disabled = true;
  try {
    const report = await buildCaptureReport({ result: snapshot, bytes: state.bytes, fileName: state.name, isSample: state.isSample, source: state.sourceScope, customDialectName: state.customDialect?.name || null, selection: reportSelection() });
    if (state.result !== snapshot) throw new Error('Capture changed while preparing the printable report. Try again.');
    const section = $('print-report-page'); section.replaceChildren(
      el('h1', { id: 'print-report-title', text: 'Mavframe link-health report' }),
      el('p', { text: `Source: ${report.source.name} · ${fmt(report.source.bytes)} bytes · SHA-256 ${report.source.sha256}` }),
      el('p', { text: `Provenance: ${report.source.scope}. Parser ${report.tool.version}, ${report.tool.parser}. Format ${report.settings.format}; dialect ${report.settings.dialect}.` }),
      el('p', { text: `Valid frames ${fmt(report.summary.valid_frames)} · CRC failures ${fmt(report.summary.crc_failures)} · sequence gaps ${fmt(report.summary.sequence_gaps)} · estimated missing ${fmt(report.summary.missing_estimate)}.` }),
      el('p', { text: report.selected_finding ? `Selected ${report.selected_finding.kind} finding at byte ${report.selected_finding.source_offset}; row ${report.selected_finding.row_index}; message ${report.selected_finding.message_id ?? 'unknown'}; sender ${report.selected_finding.system_id ?? '?'}:${report.selected_finding.component_id ?? '?'}; sequence ${report.selected_finding.sequence ?? '?'}; field ${report.selected_finding.field || 'none'}.` : 'No frame or finding is currently selected.' }),
      el('p', { text: `Timeline axis: ${report.link_health_timeline.axis}. Raw payloads are omitted.` }),
    );
    const table = el('table', { class: 'print-health-table' },
      el('thead', {}, el('tr', {}, ...['Interval · retained frame index', 'Valid', 'CRC', 'Unsupported', 'Sequence events', 'Missing estimate', 'Timestamp reversals', 'Sender IDs', 'Frames/s'].map(text => el('th', { scope: 'col', text })))),
      el('tbody', {}, ...report.link_health_timeline.bins.map(bin => el('tr', {},
        el('th', { scope: 'row', text: `${report.link_health_timeline.timeBasis === 'tlog-record-time' ? `${bin.start.toFixed(2)}–${bin.end.toFixed(2)} s` : `${bin.start}–${bin.end}`} · ${bin.firstFrame === null ? 'no frame' : `${bin.firstFrame + 1}–${bin.lastFrame + 1}`}` }),
        el('td', { text: fmt(bin.validFrames) }), el('td', { text: fmt(bin.crcFailures) }), el('td', { text: fmt(bin.unsupportedFrames) }), el('td', { text: fmt(bin.sequenceDiscontinuities) }),
        el('td', { text: fmt(bin.missingEstimate) }), el('td', { text: fmt(bin.timestampReversals) }), el('td', { text: `${bin.senders.join(', ') || 'none'}${bin.sendersOmitted ? `; +${bin.sendersOmitted}` : ''}` }),
        el('td', { text: bin.messageRateHz === null ? 'unavailable' : bin.messageRateHz.toFixed(2) })))));
    section.append(el('h2', { text: 'Link health by interval' }), table,
      el('h2', { text: 'Limits and assumptions' }), el('ul', {}, ...report.assumptions.map(note => el('li', { text: note })), ...report.link_health_timeline.assumptions.map(note => el('li', { text: note }))),
      el('p', { text: `Issue detail omissions: ${fmt(report.link_health_timeline.omitted.crcFailures)} CRC failures, ${fmt(report.link_health_timeline.omitted.unsupportedFrames)} unsupported messages and ${fmt(report.link_health_timeline.omitted.sequenceDiscontinuities)} sequence events. CRC is not authentication; signature verification is not performed.` }));
    section.hidden = false; document.body.classList.add('print-report-mode');
    const cleanup = () => { section.hidden = true; document.body.classList.remove('print-report-mode'); opener.disabled = !state.bytes; opener.focus(); };
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
    setTimeout(() => { if (document.body.classList.contains('print-report-mode')) cleanup(); }, 60000);
  } catch (error) { $('capture-export-status').textContent = `Could not prepare printable report: ${error.message}`; }
  finally { opener.disabled = !state.bytes; }
}

async function mutateByte() {
  if (state.busy || !state.bytes) return;
  const off = Number($('mutation-offset').value);
  const mask = Number($('mutation-mask').value);
  if (!Number.isSafeInteger(off) || off < 0 || off >= state.bytes.length) throw new Error('Choose a byte offset inside the current capture.');
  if (![1, 2, 4, 8, 16, 32, 64, 128].includes(mask)) throw new Error('Choose a single bit to flip.');
  const original = state.original || { bytes: state.bytes, name: state.name, isSample: state.isSample };
  const selected = state.bytes;
  const byte = state.bytes[off] ^ mask;
  const blob = new Blob([state.bytes.subarray(0, off), Uint8Array.of(byte), state.bytes.subarray(off + 1)]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (state.busy || state.bytes !== selected) throw new Error('A different capture operation started. Try the mutation again.');
  if (!await run(bytes, `${original.name} (modified copy)`, original.isSample)) return;
  state.original = original;
  $('mutation-status').textContent = `Flipped bit ${mask} at byte ${fmt(off)}. Original retained.`;
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
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  $("theme-toggle").setAttribute("aria-pressed", String(dark));
  $("theme-toggle").textContent = dark ? "Light theme" : "Dark theme";
  $("theme-toggle").setAttribute("aria-label", `${dark ? 'Light' : 'Dark'} theme (current theme: ${dark ? 'dark' : 'light'})`);
  document.querySelector('meta[name="theme-color"]').setAttribute("content", dark ? "#0f172a" : "#f8fafc");
  document.querySelector('meta[name="color-scheme"]').setAttribute("content", dark ? "dark" : "light");
  if (state.result && !$("screen-frames").hidden) renderTimeline(state.route?.screen === "details" ? state.route.index : -1);
}

function toggleTheme() {
  const dark = document.documentElement.getAttribute("data-theme") !== "dark";
  applyTheme(dark);
  const session = getSession();
  if (session?.mode === "profile") {
    try { savePreferences({ theme: dark ? "dark" : "light" }); }
    catch { setStatus("Theme changed for this tab, but browser storage could not save the profile preference.", true); }
  } else {
    try { window.localStorage.setItem("mavframe_theme_v1", dark ? "dark" : "light"); }
    catch { setStatus("Theme changed for this tab; browser storage could not remember it.", true); }
  }
}

function clearWorkspaceForLogout({ remote = false } = {}) {
  pendingGuestSave = null;
  clearSensitiveMemory();
  history.replaceState(null, "", "#/");
  renderPublic({ screen: "landing", params: {} });
  if (!remote) requestAnimationFrame(() => $("landing-title").focus());
}

function clearSensitiveMemory() {
  workspaceEpoch++;
  lastWorkspaceContext = null;
  pendingCustomDialectFile = null;
  state.parser?.setCustomExtras(new Uint32Array()); state.customDialect = null;
  state.abort?.abort(); state.abort = null;
  serialControls?.clearForLogout().catch(() => {});
  Object.assign(state, { result: null, bytes: null, name: "", isSample: false, busy: false, original: null, sourceScope: null, rows: null, rowsKey: "", anatomy: null, route: null, prevRoute: null, page: 0 });
  setBusy(false);
  $("file").value = ""; $("format").value = "auto";
  $("custom-dialect-file").value = ""; $("custom-dialect-includes").value = "";
  $("capture-result").hidden = true; $("frame-table").tBodies[0].replaceChildren(); $("detail-body").replaceChildren(); $("detail").hidden = true;
  $("live-events")?.replaceChildren(); $("capture-export-status")?.replaceChildren(); $("export-status")?.replaceChildren();
  setStatus("");
}
function hasUnsavedWork() {
  return state.busy || pendingExports > 0 || Boolean(state.bytes && (!state.isSample || state.name.includes("modified copy"))) || Boolean($("auth-submit")?.disabled) || Boolean(document.querySelector("dialog[open]")) || Boolean(pendingGuestSave);
}
function setUpdateNotice(visible, message = "A new Mavframe version is ready. Update and reload only when this tab and other Mavframe tabs are safe to reload.") {
  const notice = $("update-notice"); if (!notice) return;
  $("update-message").textContent = message; notice.hidden = !visible;
}

function safeReturnHash(hash) {
  return /^#\/(?:app|capture|frames|help)(?:[/?][A-Za-z0-9_./?=&%-]*)?$/.test(hash || "") && !hash.includes("..") ? hash : "#/";
}
function beginGuestSave(event) {
  event?.preventDefault();
  const session = getSession();
  if (session?.mode !== "guest") return;
  const returnHash = safeReturnHash(location.hash);
  pendingGuestSave = { sourceUserId: session.id, context: currentSafeContext(), returnHash };
  internalReturn = returnHash;
  history.pushState(null, "", `#/signup?return=${encodeURIComponent(returnHash)}`);
  renderPublic({ screen: "signup", params: {} });
}
function launchWorkspace(event) {
  event?.preventDefault();
  let promotedSample = false;
  let hash = "#/app";
  if (state.result) {
    const context = lastWorkspaceContext;
    if (context?.screen) hash = context.screen === "details" && context.index != null
      ? buildHash("details", { ...context.params, index: context.index, check: context.check, tab: context.tab, f: context.field })
      : buildHash(context.screen, context);
  } else if (heroSampleResult) {
    state.result = heroSampleResult.result; state.bytes = heroSampleResult.bytes; state.name = SAMPLE.name; state.isSample = true;
    state.original = { bytes: heroSampleResult.bytes, name: SAMPLE.name, isSample: true }; state.rows = null; state.rowsKey = "";
    promotedSample = true;
    hash = buildHash("details", { index: heroSampleResult.rowPosition, check: "crc", tab: "decoded", f: null });
  }
  navigate(hash);
  if (promotedSample) setStatus(`${SAMPLE.name} loaded.`);
}
async function inspectHeroSample() {
  const button = $("hero-inspect"); const status = $("hero-task-status"); const output = $("hero-task-result");
  if (state.busy || (!parserReady && !state.parser)) { status.textContent = "The parser is still preparing. Try again in a moment."; return; }
  button.disabled = true; output.hidden = true; output.replaceChildren();
  const started = performance.now(); status.textContent = "Fetching the bundled synthetic capture and checking it with the C/Wasm parser…";
  try {
    const parser = state.parser || await parserReady;
    state.parser = parser;
    const response = await fetch(SAMPLE.url);
    if (!response.ok) throw new Error(`Sample request failed (HTTP ${response.status}). Reconnect or open another capture in the workspace.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const result = await analyze(bytes, { parser, name: SAMPLE.name, format: "tlog", customDialect: state.customDialect, signal: new AbortController().signal, yieldFn: yieldToBrowser });
    const rows = filterRows(result, "crc", null);
    if (!rows.length) throw new Error("The sample parsed but contains no CRC finding to inspect. Open the frame list to review its actual results.");
    const rowPosition = rows.at(0); const ref = rowIndex(result).at(rowPosition); const info = rowInfo(result, ref);
    const linked = anatomy(result, bytes, parser, info); const crc = linked.crc;
    if (!crc) throw new Error("The selected sample row has no established CRC bytes. Choose another frame in the workspace.");
    heroSampleResult = { result, bytes, rowPosition, info };
    output.append(
      el("p", { class: "hero-finding-title", text: `${msgLabel(info.msgid)} · CRC failed` }),
      el("p", { text: `Capture offset ${fmt(info.off)} · ${result.crcErrors} CRC failures in ${fmt(result.validFrames)} valid frames` }),
      el("dl", { class: "hero-crc" }, el("div", {}, el("dt", { text: "Received" }), el("dd", { text: hexN(crc.wire, 4) })), el("div", {}, el("dt", { text: "Computed by C/Wasm" }), el("dd", { text: crc.computed === null ? "Not available" : hexN(crc.computed, 4) })), el("div", {}, el("dt", { text: "CRC byte range" }), el("dd", { text: `${crc.at}–${crc.at + 1}` }))),
      el("pre", { class: "hero-bytes", tabIndex: 0, "aria-label": "Sample frame bytes including the received checksum", text: [...bytes.subarray(info.off, Math.min(info.off + info.flen, bytes.length))].map((value, index) => `${(info.off + index).toString(16).padStart(6, "0")}: ${hexN(value, 2)}`).join("\n") }),
      el("p", { class: "muted small", text: "Synthetic sample · signature presence is not authentication; this result is a parser checksum finding." }),
    );
    output.hidden = false;
    const elapsed = ((performance.now() - started) / 1000).toFixed(2);
    status.textContent = `Inspected through the C/Wasm parser in ${elapsed} seconds on this browser.`;
  } catch (error) { status.textContent = error?.message || "The sample could not be analyzed. Retry or open a capture in the workspace."; }
  finally { button.disabled = false; }
}

async function inspectRealCapture() {
  const button = $('hero-real-sample'); const message = $('hero-real-status');
  if (state.busy || (!parserReady && !state.parser)) { message.textContent = 'The parser is still preparing. Try again in a moment.'; return; }
  if (hasUnsavedWork() && !window.confirm('Replace the capture currently open in this tab? Export it first if you need to keep a copy.')) return;
  button.disabled = true;
  const originalLabel = button.textContent; button.textContent = 'Loading 5.86 MB capture…';
  try {
    const session = getSession() || startGuest();
    sampleAttemptSession = session.nonce;
    navigate('#/app');
    const response = await fetch('sample/real-flight-redacted.tlog');
    if (!response.ok) throw new Error(`HTTP ${response.status}. Reconnect to download the bundled public sample.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== 5865472) throw new Error('The bundled sample size did not match its provenance record.');
    $('format').value = 'auto';
    const accepted = await run(bytes, 'real-flight-redacted.tlog', false);
    if (!accepted) throw new Error('The sample could not be parsed. The C/Wasm parser status has the details.');
    state.original = { bytes, name: 'real-flight-redacted.tlog', isSample: false };
    state.sourceScope = 'DroneKit-LA flight.tlog, CC BY-SA 3.0; derived sample with GPS coordinates redacted and MAVLink CRCs recomputed; see sample/real-flight-provenance.md';
    navigate('#/frames');
    message.textContent = `${fmt(state.result.validFrames)} valid frames, ${fmt(state.result.crcErrors)} CRC failures, ${fmt(state.result.gaps)} estimated sequence gaps. Coordinates were scrubbed; these are public test data, not independently verified flight evidence.`;
  } catch (error) {
    message.textContent = `Could not inspect the real-world-derived sample: ${error.message}`;
  } finally { button.disabled = false; button.textContent = originalLabel; }
}

function wirePublicActions() {
  initLocalProfiles((meta) => { disconnectCloudSync("Cloud connection ended after local profile logout."); clearWorkspaceForLogout({ remote: meta.remote }); });
  const teamForm = $('team-form');
  const endpointText = String(globalThis.MAVFRAME_TEAM_ENDPOINT || '').trim();
  let teamEndpoint = null;
  try {
    if (endpointText) {
      teamEndpoint = new URL(endpointText, location.href);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(teamEndpoint.hostname);
      if ((teamEndpoint.protocol !== 'https:' && !(local && teamEndpoint.protocol === 'http:')) || teamEndpoint.username || teamEndpoint.password || teamEndpoint.hash || teamEndpoint.href.length > 2048) throw new Error('Use an HTTPS endpoint without credentials or fragments.');
    }
  } catch { teamEndpoint = null; }
  if (teamEndpoint) {
    $('team-destination').textContent = `Submitting sends only these fields to ${teamEndpoint.origin}. Review that receiver’s privacy policy before sending.`;
    $('team-submit').textContent = 'Submit interest';
  }
  let teamDraft = null;
  teamForm.addEventListener('submit', async event => {
    event.preventDefault();
    $('team-error').hidden = true;
    $('team-status').textContent = '';
    if (!teamForm.reportValidity()) return;
    const data = { email: $('team-email').value.trim(), teamSize: $('team-size').value, useCase: $('team-use').value.trim() };
    if (!data.email || !data.teamSize || !data.useCase || data.useCase.length > 1000) {
      $('team-error').textContent = 'Enter an email, team size and use case within 1,000 characters.'; $('team-error').hidden = false; return;
    }
    if (!teamEndpoint) {
      teamDraft = data;
      $('team-status').textContent = 'Draft saved in this tab only. No request was sent and no enrollment was created.';
      return;
    }
    const submit = $('team-submit'); submit.disabled = true; submit.textContent = 'Submitting…';
    try {
      const response = await fetch(teamEndpoint, { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(data) });
      const acknowledgment = await response.text();
      if (!response.ok || acknowledgment.length > 1024) throw new Error(`Receiver returned HTTP ${response.status} or an oversized response.`);
      let receipt;
      try { receipt = JSON.parse(acknowledgment); } catch { throw new Error('Receiver did not return a readable acknowledgement.'); }
      if (!(receipt?.received === true || receipt?.ok === true)) throw new Error('Receiver did not confirm receipt.');
      teamDraft = null;
      $('team-status').textContent = 'The configured receiver confirmed this interest note. This is not access to a hosted product.';
    } catch (error) {
      $('team-error').textContent = `Could not confirm submission: ${error.message} Retry when the receiver is available. Your fields remain in this form and have not been claimed as received.`;
      $('team-error').hidden = false;
    } finally { submit.disabled = false; submit.textContent = 'Submit interest'; }
  });
  let feedbackOpener = null;
  const feedbackDialog = $("feedback-dialog");
  document.querySelectorAll("[data-open-feedback]").forEach((button) => button.addEventListener("click", () => {
    feedbackOpener = button;
    const route = parseHash(location.hash); const routeName = route.screen === "details" ? "frames/:index" : route.screen;
    $("feedback-diagnostics").textContent = [`Mavframe ${MAVFRAME_VERSION}`, `Viewport ${innerWidth} × ${innerHeight} CSS px`, `Route ${routeName}`, `Browser ${navigator.userAgent}`].join("\n");
    $("feedback-status").textContent = ""; $("feedback-destination").hidden = true;
    feedbackDialog.showModal(); $("feedback-description").focus();
  }));
  $("cancel-feedback").addEventListener("click", () => feedbackDialog.close());
  $("feedback-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const description = $("feedback-description").value.trim();
    if (!description) { $("feedback-description").focus(); return; }
    const steps = $("feedback-steps").value.trim(); const diagnostics = $("feedback-diagnostics").textContent;
    const body = [`What happened?\n${description}`, steps ? `Reproduction steps\n${steps}` : "", `Version and setup\n${diagnostics}`].filter(Boolean).join("\n\n");
    const destination = new URL("https://github.com/anirudh763/mavframe/issues/new");
    destination.searchParams.set("template", "problem.md"); destination.searchParams.set("title", "Inspector feedback"); destination.searchParams.set("body", body);
    $("feedback-destination").href = destination.href; $("feedback-destination").hidden = false;
    $("feedback-status").textContent = "Draft prepared. Open the GitHub form and submit it there; Mavframe has not sent anything.";
    $("feedback-destination").focus();
  });
  feedbackDialog.addEventListener("close", () => { const opener = feedbackOpener; feedbackOpener = null; opener?.focus(); });
  document.querySelectorAll("[data-auth-route]").forEach((link) => link.addEventListener("click", () => {
    internalReturn = safeReturnHash(location.hash);
    link.href = `#/${link.dataset.authRoute}?return=${encodeURIComponent(internalReturn)}`;
  }));
  document.querySelectorAll("[data-launch-workspace]").forEach((link) => link.addEventListener("click", launchWorkspace));
  document.querySelectorAll("[data-save-profile]").forEach((link) => link.addEventListener("click", beginGuestSave));
  $("profile-link").addEventListener("click", (event) => { if (getSession()?.mode === "guest") beginGuestSave(event); });
  $("hero-inspect").addEventListener("click", inspectHeroSample);
  $("hero-real-sample").addEventListener("click", inspectRealCapture);
  document.querySelectorAll("[data-logout]").forEach((button) => button.addEventListener("click", () => logout()));
  $("import-pending-save").addEventListener("click", async () => {
    if (!pendingGuestSave || getSession()?.mode !== "profile") return;
    const button = $("import-pending-save"); button.disabled = true;
    try {
      const saved = await saveWorkspace("Imported guest view", pendingGuestSave.context, document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
      pendingGuestSave = null;
      renderPublic({ screen: "profile", params: {} }, { keepFocus: true });
      $("profile-status").textContent = `Saved “${saved.name}”. Only view settings were imported; capture bytes remain temporary in this tab.`;
    } catch (error) { $("profile-error").textContent = error?.message || "Could not save the guest view settings."; $("profile-error").hidden = false; }
    finally { button.disabled = false; }
  });
  let encryptedBackupStage = null;
  const backupError = message => { $("backup-error").textContent = message; $("backup-error").hidden = false; $("backup-status").textContent = ""; };
  const clearBackupStage = () => { encryptedBackupStage = null; $("backup-preview-box").hidden = true; $("backup-preview-text").textContent = ""; };
  $("backup-export").addEventListener("click", async () => {
    $("backup-error").hidden = true; $("backup-status").textContent = "Encrypting the profile backup locally…";
    try {
      const backup = await createEncryptedBackup($("backup-passphrase").value);
      const url = URL.createObjectURL(new Blob([backup], { type: "application/json" }));
      const link = el("a", { href: url, download: "mavframe-profile-backup.json", hidden: true });
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      $("backup-status").textContent = "Encrypted backup downloaded. Keep its passphrase separately; it cannot be recovered.";
    } catch (error) { backupError(error.message); }
  });
  $("backup-preview").addEventListener("click", async () => {
    $("backup-error").hidden = true; $("backup-status").textContent = ""; clearBackupStage();
    const file = $("backup-file").files?.[0];
    if (!file) { backupError("Choose a backup JSON file first."); return; }
    if (file.size > 1024 * 1024) { backupError("Backup file exceeds the 1 MiB safety limit."); return; }
    try {
      const raw = await file.text();
      encryptedBackupStage = await previewEncryptedBackup(raw, $("backup-passphrase").value);
      const s = encryptedBackupStage;
      $("backup-preview-text").textContent = `Verified encrypted backup for ${s.email}: ${s.workspaceCount} saved views. ${s.existingProfile ? `Matching local profile found; ${s.conflictCount} saved view names overlap. Log in to that profile before restore or merge.` : "No matching local profile; restore creates one using this passphrase as its new local login password."}`;
      $("backup-restore").hidden = false; $("backup-merge").hidden = !s.existingProfile;
      $("backup-preview-box").hidden = false;
    } catch (error) { backupError(error.message); }
  });
  const finishBackupImport = async mode => {
    if (!encryptedBackupStage) return;
    $("backup-error").hidden = true;
    try {
      const result = await commitEncryptedBackup(encryptedBackupStage.stageId, mode);
      clearBackupStage(); $("backup-passphrase").value = ""; $("backup-file").value = "";
      $("backup-status").textContent = `Backup ${mode === "restore" ? "restored" : "merged"} locally. ${result.workspaceCount} saved views are available; no capture data was imported.`;
      if (result.createdProfile) { render(); }
    } catch (error) { backupError(error.message); }
  };
  $("backup-restore").addEventListener("click", () => finishBackupImport("restore"));
  $("backup-merge").addEventListener("click", () => finishBackupImport("merge"));
  $("backup-cancel").addEventListener("click", () => { clearBackupStage(); $("backup-file").value = ""; $("backup-status").textContent = "Import cancelled. Existing profile data was not changed."; });
  const syncError = message => { $("sync-error").textContent = message; $("sync-error").hidden = false; $("sync-status").textContent = ""; };
  const localCollection = name => name === "saved_views" ? (loadWorkspace() || []) : (loadPreferences() || { theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light" });
  const collectionLabel = name => name === "saved_views" ? "Saved view settings" : "Theme preference";
  const showSyncCollection = (name, result) => {
    const region = el("section", { class: "sync-collection", "aria-labelledby": `sync-${name}-title` });
    region.append(el("h3", { id: `sync-${name}-title`, text: collectionLabel(name) }));
    if (result.status === "current") region.append(el("p", { text: `Current on this device and cloud at revision ${result.revision}.` }));
    else if (result.status === "synced") region.append(el("p", { text: `Cloud acknowledged revision ${result.revision}.` }));
    else if (result.status === "pending-upload") {
      region.append(el("p", { text: "Local changes are pending. They remain on this device until you upload them." }));
      const upload = el("button", { type: "button", class: "btn", text: "Upload local settings" });
      upload.addEventListener("click", async () => { upload.disabled = true; try { const saved = await syncProvider.syncCollection(name, localCollection(name), "upload-local"); showSyncCollection(name, saved); } catch (error) { syncError(error.message); } }); region.append(upload);
    } else if (result.status === "conflict") {
      region.append(el("p", { role: "status", text: `Different local and cloud versions need your choice. Cloud revision ${result.revision}.` }));
      const keepLocal = el("button", { type: "button", class: "btn", text: "Keep local and upload" });
      keepLocal.addEventListener("click", async () => { keepLocal.disabled = true; try { showSyncCollection(name, await syncProvider.syncCollection(name, localCollection(name), "upload-local")); } catch (error) { syncError(error.message); } });
      const useRemote = el("button", { type: "button", class: "btn", text: "Use cloud version" });
      useRemote.addEventListener("click", async () => { useRemote.disabled = true; try { const remote = await syncProvider.syncCollection(name, localCollection(name), "use-remote"); if (remote.payload === null) throw new Error("Cloud returned an empty collection; local data was not removed."); await applyCloudCollection(name, remote.payload); $("sync-status").textContent = `Applied the acknowledged cloud ${collectionLabel(name).toLowerCase()} locally.`; showSyncCollection(name, { status: "current", revision: remote.revision }); } catch (error) { syncError(error.message); } });
      region.append(keepLocal, useRemote);
    }
    if (Number.isSafeInteger(result.revision) && result.revision > 0 && ["current", "conflict", "pending-upload", "synced"].includes(result.status)) {
      const remove = el("button", { type: "button", class: "btn", text: "Delete cloud copy" });
      remove.addEventListener("click", async () => { if (!window.confirm(`Delete only the cloud ${collectionLabel(name).toLowerCase()}? This does not delete local settings.`)) return; remove.disabled = true; try { await syncProvider.deleteCollection(name, result.revision); region.replaceChildren(el("h3", { text: collectionLabel(name) }), el("p", { text: "Cloud copy deleted; local settings remain on this device." })); } catch (error) { syncError(error.message); remove.disabled = false; } }); region.append(remove);
    }
    const list = $("sync-collections"); const previous = list.querySelector(`#sync-${name}`); region.id = `sync-${name}`; if (previous) previous.replaceWith(region); else list.append(region);
  };
  $("sync-connect").addEventListener("click", async () => {
    $("sync-error").hidden = true; $("sync-status").textContent = "";
    if (getSession()?.mode !== "profile") { syncError("Log in to a local profile before connecting its saved settings to a cloud account."); return; }
    if (!$("sync-consent").checked) { syncError("Confirm the collection scope before connecting."); return; }
    const button = $("sync-connect"); button.disabled = true;
    try {
      syncProvider = createSyncProvider({ projectUrl: $("sync-project").value.trim(), anonKey: $("sync-anon-key").value.trim() });
      const connected = await syncProvider.connect($("sync-email").value.trim(), $("sync-password").value);
      syncBoundProfileId = getSession()?.id || null;
      $("sync-password").value = ""; $("sync-now").disabled = false;
      $("sync-status").textContent = `Connected to the configured cloud account for this tab. Local profile credentials are separate; the provider token remains in memory only.`;
      button.textContent = "Reconnect cloud account";
    } catch (error) { syncProvider?.logout(); syncProvider = null; syncError(error.message); }
    finally { button.disabled = false; }
  });
  $("sync-now").addEventListener("click", async () => {
    if (!syncProvider?.connected) { syncError("Connect the cloud account first."); return; }
    $("sync-error").hidden = true; $("sync-status").textContent = "Checking acknowledged cloud revisions…";
    const button = $("sync-now"); button.disabled = true;
    try {
      for (const name of ["saved_views", "preferences"]) showSyncCollection(name, await syncProvider.syncCollection(name, localCollection(name)));
      $("sync-status").textContent = "Sync check finished. Pending local changes are labeled and are not reported as uploaded.";
    } catch (error) { syncError(error.message); }
    finally { button.disabled = false; }
  });
  $("quickstart-dismiss").addEventListener("click", () => { loadQuickStart(); quickStartMemory.dismissed = true; saveQuickStart(); renderQuickStart(); });
  $("quickstart-restart").addEventListener("click", () => { loadQuickStart(); quickStartMemory.dismissed = false; quickStartMemory.steps = [false, false, false]; saveQuickStart(); renderQuickStart(); $("quickstart").open = true; });
  document.querySelectorAll("[data-demo]").forEach((link) => link.addEventListener("click", () => {
    const previous = getSession();
    if (previous?.mode === "profile" && state.bytes && !window.confirm("Starting a guest demo clears this tab’s unsaved capture from memory. Export it first if you need to keep it. Continue?")) return;
    try {
      const next = startGuest();
      if (previous && previous.id !== next.id) clearSensitiveMemory();
    } catch { /* render guard reports unavailable session storage */ }
  }));
  $("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorNode = $("auth-error"); const status = $("auth-status"); const button = $("auth-submit");
    errorNode.hidden = true; errorNode.textContent = ""; status.textContent = ""; button.disabled = true;
    const password = $("auth-password").value; const authRoute = parseHash(location.hash).screen; const previous = getSession();
    $("auth-email").removeAttribute("aria-invalid"); $("auth-password").removeAttribute("aria-invalid");
    try {
      const destinationEmail = $("auth-email").value.trim().toLowerCase();
      const currentEmail = previous?.mode === "profile" ? getProfile()?.email : null;
      const switching = previous && (previous.mode === "guest" || authRoute === "signup" || currentEmail !== destinationEmail);
      const explicitImport = Boolean(pendingGuestSave && previous && pendingGuestSave.sourceUserId === previous.id);
      if (switching && state.bytes && !explicitImport && !window.confirm("Signing into another profile clears this guest or profile capture from this tab. Export it first if you need a copy. Continue?")) {
        status.textContent = "Profile switch cancelled. Your current workspace remains in this tab."; return;
      }
      status.textContent = authRoute === "login" ? "Checking this browser’s profile…" : "Preparing the local password record…";
      if (authRoute === "login") await login($("auth-email").value, password);
      else await signup($("auth-email").value, password);
      const current = getSession();
      if (previous && previous.id !== current?.id && !explicitImport) clearSensitiveMemory();
      $("auth-password").value = "";
      let saved = []; let preferences = null; let savedWarning = "";
      try { saved = loadWorkspace() || []; } catch (error) { savedWarning = "Saved views could not be read: " + error.message; }
      if (saved?.[0]) lastWorkspaceContext = saved[0].context;
      try { preferences = loadPreferences(); } catch (error) { savedWarning ||= "Profile preferences could not be read: " + error.message; }
      applyTheme((preferences?.theme || saved?.[0]?.theme || "dark") === "dark");
      if (explicitImport && current?.mode === "profile") {
        pendingGuestSave.sourceUserId = current.id;
        history.replaceState(null, "", "#/profile");
      } else history.replaceState(null, "", internalReturn || "#/app");
      render();
      if (savedWarning) setStatus(savedWarning, true);
    } catch (cause) {
      status.textContent = ""; errorNode.textContent = cause?.message || "Could not use this local profile."; errorNode.hidden = false;
      const message = errorNode.textContent.toLowerCase();
      if (message.includes("email")) { $("auth-email").setAttribute("aria-invalid", "true"); $("auth-email").focus(); }
      else if (message.includes("password") || message.includes("did not match")) { $("auth-password").setAttribute("aria-invalid", "true"); $("auth-password").focus(); }
    }
    finally { button.disabled = false; }
  });
  $("password-visibility").addEventListener("click", (event) => {
    const input = $("auth-password"); const show = input.type === "password";
    input.type = show ? "text" : "password"; event.currentTarget.textContent = show ? "Hide" : "Show"; event.currentTarget.setAttribute("aria-pressed", String(show)); input.focus();
  });
  $("logout-button").addEventListener("click", () => logout());
  $("save-context-form").addEventListener("submit", async (event) => {
    event.preventDefault(); $("profile-error").hidden = true;
    try {
      const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      const saved = await saveWorkspace($("context-name").value, currentSafeContext(), theme);
      $("profile-status").textContent = `Saved “${saved.name}”. Only filters, selection context and theme are stored; capture data is not.`;
    } catch (cause) { $("profile-error").textContent = cause?.message || "Could not save this view."; $("profile-error").hidden = false; }
  });
  $("landing-menu").addEventListener("click", () => {
    const button = $("landing-menu"); const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open)); document.body.classList.toggle("landing-menu-open", open);
  });
  document.querySelectorAll(".mega").forEach((menu) => {
    menu.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); menu.open = false; menu.querySelector("summary").focus(); } });
    menu.addEventListener("focusout", () => requestAnimationFrame(() => { if (!menu.contains(document.activeElement) && !menu.matches(":hover")) menu.open = false; }));
  });
  const showcaseIcons = ["file-search", "scan-line", "book-open"];
  const iconFor = new Map();
  document.querySelectorAll(".mega-panel a").forEach((link, index) => {
    const name = showcaseIcons[index % showcaseIcons.length];
    let icon = iconFor.get(name);
    if (!icon) {
      icon = svgEl("svg", { class: "mega-icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
      for (const [tag, attrs] of NAV_ICONS[name]) icon.append(svgEl(tag, attrs));
      iconFor.set(name, icon);
    }
    link.prepend(icon.cloneNode(true));
  });
  $("landing-menu").addEventListener("keydown", (event) => {
    if (event.key === "Escape" && event.currentTarget.getAttribute("aria-expanded") === "true") {
      event.preventDefault(); event.currentTarget.setAttribute("aria-expanded", "false"); document.body.classList.remove("landing-menu-open"); event.currentTarget.focus();
    }
  });
  document.querySelectorAll(".landing-header a").forEach((link) => link.addEventListener("click", () => {
    document.body.classList.remove("landing-menu-open"); $("landing-menu").setAttribute("aria-expanded", "false");
  }));
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let slide = 0; let paused = reduceMotion.matches; let explicitlyPaused = false; let hovered = false; let focused = false; let timer = null;
  const captions = ["Synthetic sample · capture summary", "CRC filter · illustrative row", "Linked fields and bytes", "Finding export · payload opt-in"];
  const showSlide = (next) => {
    slide = (next + 4) % 4;
    document.querySelectorAll("[data-slide]").forEach((item) => { item.hidden = Number(item.dataset.slide) !== slide; });
    document.querySelectorAll("[data-show-slide]").forEach((item) => item.setAttribute("aria-pressed", String(Number(item.dataset.showSlide) === slide)));
    $("showcase-caption").textContent = captions[slide];
  };
  const restart = () => { clearInterval(timer); timer = !paused && !document.hidden ? setInterval(() => showSlide(slide + 1), 6500) : null; };
  const updatePlayback = () => { paused = reduceMotion.matches || explicitlyPaused || hovered || focused; restart(); };
  document.querySelectorAll("[data-show-slide]").forEach((button) => button.addEventListener("click", () => { showSlide(Number(button.dataset.showSlide)); restart(); }));
  const showcase = document.querySelector(".showcase");
  showcase.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse") { hovered = true; updatePlayback(); } });
  showcase.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse") { hovered = false; updatePlayback(); } });
  showcase.addEventListener("focusin", () => { focused = true; updatePlayback(); });
  showcase.addEventListener("focusout", () => requestAnimationFrame(() => { focused = showcase.contains(document.activeElement); updatePlayback(); }));
  $("showcase-pause").addEventListener("click", (event) => {
    if (reduceMotion.matches) return;
    explicitlyPaused = !explicitlyPaused;
    event.currentTarget.textContent = explicitlyPaused ? "Play" : "Pause"; event.currentTarget.setAttribute("aria-pressed", String(explicitlyPaused)); updatePlayback();
  });
  if (reduceMotion.matches) { $("showcase-pause").textContent = "Autoplay off"; $("showcase-pause").disabled = true; }
  document.addEventListener("visibilitychange", restart);
  reduceMotion.addEventListener?.("change", (event) => {
    $("showcase-pause").disabled = event.matches;
    $("showcase-pause").textContent = event.matches ? "Autoplay off" : explicitlyPaused ? "Play" : "Pause";
    updatePlayback();
  });
  restart();
}

// ---------- wiring ----------
function wire() {
  wirePublicActions();
  const bindDialog = (opener, dialog, closer, first) => {
    $(opener).addEventListener('click', () => { $(dialog).showModal(); $(first).focus(); });
    $(closer).addEventListener('click', () => $(dialog).close());
    $(dialog).addEventListener('close', () => {
      const target = $(opener).offsetParent !== null ? $(opener) : [...document.querySelectorAll('main h1')].find(element => element.offsetParent !== null);
      target?.focus();
    });
    $(dialog).addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const items = focusables($(dialog)).filter(element => !element.disabled);
      if (event.shiftKey && (document.activeElement === items[0] || !items.includes(document.activeElement))) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && (document.activeElement === items.at(-1) || !items.includes(document.activeElement))) { event.preventDefault(); items[0]?.focus(); }
    });
  };
  bindDialog('open-byte-editor', 'byte-editor-dialog', 'close-byte-editor', 'mutation-offset');
  $("share-finding").addEventListener("click", prepareFindingShare);
  $("share-report").addEventListener("click", prepareReportShare);
  $("cancel-share").addEventListener("click", () => $("share-dialog").close());
  $("confirm-share").addEventListener("click", () => completeShare());
  $("copy-share").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(shareDraft?.text || "");
      $("share-status").textContent = "Copied to the clipboard. Choose where to paste it.";
    } catch {
      const range = document.createRange(); range.selectNodeContents($("share-preview")); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      $("share-status").textContent = "Clipboard access is unavailable. The preview text is selected so you can copy it manually.";
      $("share-preview").focus();
    }
  });
  $("share-dialog").addEventListener("close", () => {
    const target = shareDraft?.kind === "finding" ? $("share-finding") : $("share-report");
    shareDraft = null; target?.focus();
  });
  pwa = initPwa({ busy: hasUnsavedWork, onUpdateAvailable: setUpdateNotice });
  $("offline-prepare").addEventListener("click", async () => {
    const button = $("offline-prepare"); button.disabled = true;
    try { await pwa?.checkOffline(); }
    finally { button.disabled = false; }
  });
  $("accept-update").addEventListener("click", async () => {
    const result = await acceptUpdate();
    if (result.ok) { $("update-message").textContent = "Update accepted. Mavframe will reload when the new worker controls this page."; $("accept-update").disabled = true; }
    else if (result.reason === "busy") setUpdateNotice(true, "Finish or export this tab’s open work before updating. Other Mavframe tabs are checked too.");
    else if (result.reason === "peer-busy") setUpdateNotice(true, "Another Mavframe tab has work open. Finish it there, then retry the update.");
    else if (result.reason === "coordination-unavailable") setUpdateNotice(true, "This browser cannot coordinate update safety across tabs. Close other Mavframe tabs and reopen the app to update.");
  });
  $("defer-update").addEventListener("click", () => setUpdateNotice(false));
  const names = { capture: 'file-search', frames: 'scan-line', help: 'book-open' };
  for (const link of document.querySelectorAll('.nav a[data-route]')) {
    const icon = svgEl('svg', { class: 'nav-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    for (const [tag, attrs] of NAV_ICONS[names[link.dataset.route]]) icon.append(svgEl(tag, attrs));
    link.prepend(icon);
  }
  serialControls = wireSerial({
    customExtras: () => state.customDialect?.pairs || new Uint32Array(),
    selectedFrame() {
      const r = state.result;
      if (!r?.frameCount || state.busy) return null;
      const off = r.frames.off[0];
      return state.bytes.slice(off, off + r.frames.flen[0]);
    },
    async inspectCapture(bytes, scope) {
      if (state.busy) throw new Error('Finish or cancel the current file analysis, then capture another serial tail.');
      $('format').value = 'raw';
      if (await run(bytes, 'live-tail.raw', false)) {
        state.sourceScope = scope;
        state.original = { bytes, name: 'live-tail.raw', isSample: false };
        render({ keepFocus: true });
      }
    },
  });
  applyTheme(document.documentElement.getAttribute("data-theme") !== "light");
  const activeSession = getSession();
  if (activeSession?.mode === "profile") {
    try { const preferences = loadPreferences(); if (preferences) applyTheme(preferences.theme === "dark"); }
    catch { setStatus("This profile’s theme preference could not be read. Using the current browser theme.", true); }
  }
  WIDE.addEventListener("change", () => render({ keepFocus: true }));
  window.addEventListener("resize", () => render({ keepFocus: true }));
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
  window.addEventListener("popstate", () => render());
  for (const a of document.querySelectorAll("[data-product-route]")) a.addEventListener("click", event => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(a.getAttribute("href"));
  });
  $("refresh-system").addEventListener("click", refreshSystem);
  document.addEventListener("click", event => {
    const link = event.target.closest('a[href^="/anomalies"], a[href^="/stream"]');
    if (!link || link.hasAttribute("data-product-route") || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(link.getAttribute("href"));
  });

  $("load-sample").addEventListener("click", async () => {
    await loadSample();
    // The button is disabled while loading, which drops keyboard focus; give it back.
    if (document.activeElement === document.body) $("load-sample").focus();
  });
  $("cancel").addEventListener("click", () => state.abort?.abort());
  $("file").addEventListener("change", (e) => { openFile(e.target.files[0]); e.target.value = ""; });
  $("custom-dialect-file").addEventListener("change", async event => {
    pendingCustomDialectFile = event.target.files[0] || pendingCustomDialectFile;
    event.target.value = "";
    if (pendingCustomDialectFile) await loadCustomDialect(pendingCustomDialectFile, [...$("custom-dialect-includes").files]);
  });
  $("custom-dialect-includes").addEventListener("change", async event => {
    if (pendingCustomDialectFile) await loadCustomDialect(pendingCustomDialectFile, [...event.target.files]);
  });
  $("clear-custom-dialect").addEventListener("click", clearCustomDialect);
  $("format").addEventListener("change", () => { if (state.bytes) run(state.bytes, state.name, state.isSample); });
  for (const button of document.querySelectorAll('[data-capture-export]')) button.addEventListener('click', () => exportCapture(button.dataset.captureExport).catch(error => { $('capture-export-status').textContent = `Could not export: ${error.message}`; }));
  $('mutate-byte').addEventListener('click', () => mutateByte().catch(error => { $('mutation-status').textContent = error.message; }));
  $('restore-capture').addEventListener('click', async () => {
    if (state.original && !state.busy) {
      await run(state.original.bytes, state.original.name, state.original.isSample);
      $('mutation-status').textContent = 'Original bytes restored and checked by the C/Wasm parser.';
    }
  });

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
  for (const id of ["print-report", "print-report-detail"]) $(id).addEventListener("click", () => { printCaptureReport(); });
  let t = 0;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => { if (state.result && !$("screen-frames").hidden) renderTimeline(state.route?.screen === "details" ? state.route.index : -1); }, 100); }).observe($("timeline"));
  $("timeline").closest("details").addEventListener("toggle", () => {
    if (state.result && $("timeline").closest("details").open) renderTimeline(state.route?.screen === "details" ? state.route.index : -1);
  });
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
  ensureDemoSample();
  if (!state.result) render({ keepFocus: true });
}

main();
