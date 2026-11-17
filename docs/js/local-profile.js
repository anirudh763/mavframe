const APP = "mavframe";
const SCHEMA = 1;
const KDF_VERSION = "pbkdf2-hmac-sha256-v1";
const ITERATIONS = 600_000;
const SESSION_KEY = `${APP}_session_v${SCHEMA}`;
const LEGACY_SESSION_KEY = `${APP}:session:v${SCHEMA}`;
const INDEX_KEY = `${APP}_profiles_v${SCHEMA}`;
const LEGACY_INDEX_KEY = `${APP}:profiles:v${SCHEMA}`;
// Keep cross-version coordination channels stable while storage keys migrate.
const CHANNEL_NAME = `${APP}:profile-events:v${SCHEMA}`;
const LOGOUT_KEY = `${APP}_logout_event_v${SCHEMA}`;
const LEGACY_LOGOUT_KEY = `${APP}:logout-event:v${SCHEMA}`;
const encoder = new TextEncoder();
let logoutHandler = () => {};
let channel = null;
let volatileSession = null;
let serviceEpoch = 0;
let pendingProfileId = null;
const backupStages = new Map();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function storage() {
  try {
    const store = window.localStorage;
    const probe = `${APP}_storage_probe`;
    store.setItem(probe, "1"); store.removeItem(probe);
    return store;
  } catch {
    throw new Error("Browser storage is unavailable. Check this browser’s privacy settings, then try again.");
  }
}
function sessionStore() {
  try { return window.sessionStorage; }
  catch { throw new Error("This tab cannot keep a local session. Check browser storage settings, then try again."); }
}
function randomId() {
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure random generation is unavailable in this browser context.");
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
function b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function fromB64(text) { return Uint8Array.from(atob(text), (character) => character.charCodeAt(0)); }
function profileKey(id) { return `${APP}_profile_v${SCHEMA}_${id}`; }
function legacyProfileKey(id) { return `${APP}:profile:v${SCHEMA}:${id}`; }
function workspaceKey(id) { return `${APP}_workspace_v${SCHEMA}_${id}`; }
function legacyWorkspaceKey(id) { return `${APP}:workspace:v${SCHEMA}:${id}`; }
function preferencesKey(id) { return `${APP}_preferences_v${SCHEMA}_${id}`; }
function legacyPreferencesKey(id) { return `${APP}:preferences:v${SCHEMA}:${id}`; }
function readNamespaced(store, primary, legacy) { return store.getItem(primary) ?? (legacy ? store.getItem(legacy) : null); }
function readIndex() {
  const value = readNamespaced(storage(), INDEX_KEY, LEGACY_INDEX_KEY);
  if (!value) return [];
  if (value.length > 256 * 1024) throw new Error("The saved profile index exceeds the 256 KiB safety limit and was not changed.");
  let records;
  try { records = JSON.parse(value); }
  catch { throw new Error("Saved profile index is invalid. Remove its browser data to continue."); }
  if (!Array.isArray(records) || records.length > 500) throw new Error("Saved profile index is invalid or exceeds the 500-profile limit.");
  const ids = new Set(); const emails = new Set();
  for (const record of records) {
    if (!record || typeof record.id !== "string" || !UUID.test(record.id) || typeof record.email !== "string" ||
        record.email.length > 254 || !EMAIL.test(record.email) || record.email !== record.email.toLowerCase() ||
        ids.has(record.id) || emails.has(record.email)) throw new Error("Saved profile index is malformed. No profile data was changed.");
    ids.add(record.id); emails.add(record.email);
  }
  return records;
}
function readProfile(id) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Profile identifier is invalid.");
  const value = readNamespaced(storage(), profileKey(id), legacyProfileKey(id));
  if (!value) return null;
  if (value.length > 2048) throw new Error("The local password record exceeds its 2 KiB safety limit.");
  let profile;
  try { profile = JSON.parse(value); }
  catch { throw new Error("The local password record is malformed."); }
  if (profile?.schema !== SCHEMA || profile.id !== id || typeof profile.email !== "string" ||
      profile.email.length > 254 || !EMAIL.test(profile.email) || profile.email !== profile.email.toLowerCase() ||
      profile.kdf !== KDF_VERSION || profile.iterations !== ITERATIONS ||
      typeof profile.salt !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(profile.salt) ||
      typeof profile.verifier !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(profile.verifier) ||
      typeof profile.createdAt !== "string") throw new Error("The local password record has an unsupported schema or KDF.");
  if (fromB64(profile.salt).length !== 16 || fromB64(profile.verifier).length !== 32) throw new Error("The local password record has invalid salt or verifier bytes.");
  return profile;
}
function decodeWorkspaces(value, userId) {
  if (value.length > 64 * 1024) throw new Error("Saved view data exceeds the 64 KiB safety limit.");
  let decoded;
  try { decoded = JSON.parse(value); }
  catch { throw new Error("Saved view data is malformed."); }
  if (decoded?.schema !== SCHEMA || decoded.userId !== userId || !Array.isArray(decoded.workspaces) || decoded.workspaces.length > 10) {
    throw new Error("Saved view data uses an unsupported schema or exceeds the 10-view limit.");
  }
  const names = new Set();
  return decoded.workspaces.map((item) => {
    if (!item || typeof item.name !== "string" || !item.name.length || item.name.length > 80 ||
        typeof item.savedAt !== "string" || item.savedAt.length > 64 ||
        (item.theme !== "light" && item.theme !== "dark") || !item.context || typeof item.context !== "object" ||
        names.has(item.name)) throw new Error("A saved view is malformed. Nothing was changed.");
    names.add(item.name);
    return { name: item.name, savedAt: item.savedAt, context: safeContext(item.context), theme: item.theme };
  });
}
function writeSession(value) { const store = sessionStore(); store.setItem(SESSION_KEY, JSON.stringify(value)); store.removeItem(LEGACY_SESSION_KEY); }
function clearSession() { try { const store = sessionStore(); store.removeItem(SESSION_KEY); store.removeItem(LEGACY_SESSION_KEY); } catch { /* page memory is still cleared */ } }
function derive(password, salt) {
  if (!crypto?.subtle) throw new Error("Web Crypto is unavailable. Open Mavframe from HTTPS or localhost to use local profiles.");
  return crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"])
    .then((key) => crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, key, 256));
}
function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
function safeContext(value) {
  const allowedScreens = new Set(["capture", "frames", "details", "help"]);
  const check = ["all", "issues", "crc", "unsupported", "valid"].includes(value?.check) ? value.check : "all";
  const tab = ["decoded", "bytes", "header"].includes(value?.tab) ? value.tab : "decoded";
  const screen = allowedScreens.has(value?.screen) ? value.screen : "capture";
  const msg = Number.isSafeInteger(value?.msg) && value.msg >= 0 && value.msg <= 1_000_000 ? value.msg : null;
  const index = Number.isSafeInteger(value?.index) && value.index >= 0 && value.index <= 999_999_999 ? value.index : null;
  const page = Number.isSafeInteger(value?.page) && value.page >= 1 && value.page <= 1_000_000 ? value.page : 1;
  const field = typeof value?.field === "string" && /^[A-Za-z0-9_.:[\]-]{1,128}$/.test(value.field) ? value.field : null;
  return { screen, check, tab, msg, index, page, field };
}
function withProfileIndexLock(work) {
  if (!globalThis.navigator?.locks?.request) throw new Error("This browser cannot safely coordinate profile changes across tabs. Use a current browser with Web Locks enabled.");
  return navigator.locks.request(APP + ":profile-index:v" + SCHEMA, { mode: "exclusive" }, work);
}
function withWorkspaceLock(work) {
  if (!globalThis.navigator?.locks?.request) throw new Error("This browser cannot safely coordinate saved view changes across tabs. Use a current browser with Web Locks enabled.");
  return navigator.locks.request(APP + ":workspace:v" + SCHEMA, { mode: "exclusive" }, work);
}
function announceLogout(id) {
  try { channel?.postMessage({ type: "logout", id }); } catch { /* storage event fallback below */ }
  try { const store = storage(); const value = JSON.stringify({ id, at: Date.now(), nonce: randomId() }); store.setItem(LOGOUT_KEY, value); store.setItem(LEGACY_LOGOUT_KEY, value); } catch { /* same-tab logout remains effective */ }
}

function migrateLegacyNamespace() {
  try {
    const store = storage();
    if (store.getItem(INDEX_KEY)) return;
    const legacy = store.getItem(LEGACY_INDEX_KEY);
    if (!legacy || legacy.length > 256 * 1024) return;
    let records;
    try { records = JSON.parse(legacy); } catch { return; }
    if (!Array.isArray(records) || records.length > 500) return;
    for (const record of records) {
      if (typeof record?.id !== "string" || !UUID.test(record.id)) continue;
      for (const [oldKey, newKey, limit] of [
        [legacyProfileKey(record.id), profileKey(record.id), 2048],
        [legacyWorkspaceKey(record.id), workspaceKey(record.id), 64 * 1024],
        [legacyPreferencesKey(record.id), preferencesKey(record.id), 1024],
      ]) {
        if (store.getItem(newKey) !== null) continue;
        const value = store.getItem(oldKey);
        if (value !== null && value.length <= limit) store.setItem(newKey, value);
      }
    }
    // Keep the legacy index untouched as a recoverable copy; switching the index
    // namespace is the final write so a quota failure leaves fallback reads intact.
    store.setItem(INDEX_KEY, legacy);
  } catch { /* Fallback readers continue using the untouched legacy records. */ }
}

export function initLocalProfiles(onLogout = () => {}) {
  migrateLegacyNamespace();
  logoutHandler = onLogout;
  if ("BroadcastChannel" in window) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener("message", ({ data }) => {
      const current = getSession();
      if (data?.type === "logout" && (current?.id === data.id || pendingProfileId === data.id)) {
        invalidatePrivateOperations();
        if (current?.id === data.id) {
          clearSession(); volatileSession = null; logoutHandler({ remote: true, id: data.id });
        }
        if (pendingProfileId === data.id) pendingProfileId = null;
      }
    });
  }
  window.addEventListener("storage", (event) => {
    const current = getSession();
    if (current?.mode === "profile" && (event.key === null || (event.key === INDEX_KEY || event.key === LEGACY_INDEX_KEY) && event.newValue === null || (event.key === profileKey(current.id) || event.key === legacyProfileKey(current.id)) && event.newValue === null)) {
      invalidatePrivateOperations(); clearSession(); volatileSession = null; pendingProfileId = null;
      logoutHandler({ remote: true, id: current.id, reason: "profile-storage-removed" });
      return;
    }
    if (![LOGOUT_KEY, LEGACY_LOGOUT_KEY].includes(event.key) || !event.newValue) return;
    try {
      const message = JSON.parse(event.newValue); const current = getSession();
      if (current?.id === message.id || pendingProfileId === message.id) {
        invalidatePrivateOperations();
        if (current?.id === message.id) { clearSession(); volatileSession = null; logoutHandler({ remote: true, id: message.id }); }
        if (pendingProfileId === message.id) pendingProfileId = null;
      }
    } catch { /* Ignore malformed cross-tab event data. */ }
  });
}

export function getSession() {
  if (volatileSession) return volatileSession;
  try {
    const value = readNamespaced(sessionStore(), SESSION_KEY, LEGACY_SESSION_KEY);
    if (!value) return null;
    if (value.length > 2048) return null;
    const session = JSON.parse(value);
    if (session?.schema !== SCHEMA || !["profile", "guest"].includes(session.mode) || typeof session.id !== "string" ||
        !UUID.test(session.id) || typeof session.nonce !== "string" || !UUID.test(session.nonce)) return null;
    try { const store = sessionStore(); if (store.getItem(SESSION_KEY) === null) { store.setItem(SESSION_KEY, JSON.stringify(session)); store.removeItem(LEGACY_SESSION_KEY); } } catch { /* Existing session remains usable in memory for this read. */ }
    return session;
  } catch { return null; }
}
export function getProfile() {
  const session = getSession();
  if (!session || session.mode !== "profile") return null;
  try {
    return readProfile(session.id);
  } catch { return null; }
}
export function listProfiles() {
  return readIndex().map(({ email }) => email);
}

export async function signup(emailInput, password) {
  const email = String(emailInput || "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new Error("Enter a valid email address.");
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) throw new Error("Use a password with at least 12 characters.");
  if (!globalThis.navigator?.locks?.request) throw new Error("This browser cannot safely coordinate profile changes across tabs. Use a current browser with Web Locks enabled.");
  const epoch = serviceEpoch;
  const id = randomId();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const verifier = await derive(password, salt);
  if (epoch !== serviceEpoch) throw new DOMException("Profile creation cancelled because the session changed.", "AbortError");
  const profile = { schema: SCHEMA, id, email, createdAt: new Date().toISOString(), kdf: KDF_VERSION, iterations: ITERATIONS, salt: b64(salt), verifier: b64(verifier) };
  return withProfileIndexLock(async () => {
    if (epoch !== serviceEpoch) throw new DOMException("Profile creation cancelled because the session changed.", "AbortError");
    const records = readIndex();
    if (records.some((record) => record.email === email)) throw new Error("A profile with this email already exists on this browser. Log in instead.");
    if (records.length >= 500) throw new Error("This browser has reached the 500-profile safety limit. Clear Mavframe site data in browser settings to remove profiles.");
    const store = storage();
    const originalIndex = store.getItem(INDEX_KEY);
    store.setItem(profileKey(id), JSON.stringify(profile));
    try {
      store.setItem(INDEX_KEY, JSON.stringify([...records, { id, email }]));
      if (epoch !== serviceEpoch) throw new DOMException("Profile creation cancelled because the session changed.", "AbortError");
      writeSession({ schema: SCHEMA, mode: "profile", id, nonce: randomId() });
      volatileSession = null; invalidatePrivateOperations();
    } catch (error) {
      try {
        store.removeItem(profileKey(id));
        if (originalIndex === null) store.removeItem(INDEX_KEY); else store.setItem(INDEX_KEY, originalIndex);
      } catch { /* Keep the original error visible; do not claim rollback succeeded. */ }
      throw error;
    }
    return profile;
  });
}

export async function login(emailInput, password) {
  const email = String(emailInput || "").trim().toLowerCase();
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) throw new Error("Use a password between 12 and 1,024 characters.");
  const listed = readIndex().find((record) => record.email === email);
  if (!listed) throw new Error("Email or password did not match a profile on this browser.");
  const epoch = serviceEpoch;
  pendingProfileId = listed.id;
  let profile;
  try { profile = readProfile(listed.id); }
  catch (error) { pendingProfileId = null; throw error; }
  if (!profile) { pendingProfileId = null; throw new Error("This profile’s local password record is missing."); }
  if (profile.email !== email) { pendingProfileId = null; throw new Error("The saved profile index does not match its password record."); }
  let actual;
  try { actual = await derive(password, fromB64(profile.salt)); }
  catch (error) { pendingProfileId = null; throw error; }
  if (epoch !== serviceEpoch) { pendingProfileId = null; throw new DOMException("Login cancelled because the session changed.", "AbortError"); }
  if (!equalBytes(new Uint8Array(actual), fromB64(profile.verifier))) { pendingProfileId = null; throw new Error("Email or password did not match a profile on this browser."); }
  if (epoch !== serviceEpoch) { pendingProfileId = null; throw new DOMException("Login cancelled because the session changed.", "AbortError"); }
  try { writeSession({ schema: SCHEMA, mode: "profile", id: profile.id, nonce: randomId() }); }
  catch (error) { pendingProfileId = null; throw error; }
  volatileSession = null; pendingProfileId = null; invalidatePrivateOperations();
  return profile;
}

export function startGuest() {
  invalidatePrivateOperations();
  pendingProfileId = null;
  const session = { schema: SCHEMA, mode: "guest", id: randomId(), nonce: randomId() };
  volatileSession = session;
  try { writeSession(session); volatileSession = null; } catch { volatileSession = session; }
  return session;
}

export function invalidatePrivateOperations() {
  serviceEpoch++;
  pendingProfileId = null;
  backupStages.clear();
}

export function logout() {
  const current = getSession();
  invalidatePrivateOperations();
  pendingProfileId = null;
  clearSession(); volatileSession = null;
  if (current) announceLogout(current.id);
  logoutHandler({ remote: false, id: current?.id });
}

export function loadWorkspace() {
  const current = getSession();
  if (!current || current.mode !== "profile") return null;
  const store = storage(); const data = readNamespaced(store, workspaceKey(current.id), legacyWorkspaceKey(current.id));
  if (!data) return [];
  try { return decodeWorkspaces(data, current.id); }
  catch (error) { throw new Error(error.message + " Profile and capture data were not changed."); }
}

export function loadPreferences() {
  const current = getSession();
  if (!current || current.mode !== "profile") return null;
  const store = storage(); const value = readNamespaced(store, preferencesKey(current.id), legacyPreferencesKey(current.id));
  if (!value) return null;
  if (value.length > 1024) throw new Error("Profile preferences exceed the 1 KiB safety limit.");
  let preferences;
  try { preferences = JSON.parse(value); }
  catch { throw new Error("Profile preferences are malformed."); }
  if (preferences?.schema !== SCHEMA || preferences.userId !== current.id) throw new Error("Profile preferences are invalid.");
  return { theme: preferences.theme === "dark" ? "dark" : "light" };
}

export function savePreferences(preferences) {
  const current = getSession();
  if (!current || current.mode !== "profile") return false;
  storage().setItem(preferencesKey(current.id), JSON.stringify({ schema: SCHEMA, userId: current.id, theme: preferences?.theme === "dark" ? "dark" : "light" }));
  return true;
}

export async function saveWorkspace(nameInput, context, theme) {
  const current = getSession();
  if (!current || current.mode !== "profile") throw new Error("Sign in to save view settings on this browser.");
  const epoch = serviceEpoch;
  const name = String(nameInput || "Saved view").replace(/[\u0000-\u001f\u007f]/g, "").trim() || "Saved view";
  if (name.length > 80) throw new Error("Saved view names must be 80 characters or fewer.");
  const item = { name, savedAt: new Date().toISOString(), context: safeContext(context), theme: theme === "dark" ? "dark" : "light" };
  return withWorkspaceLock(() => {
    const active = getSession();
    if (epoch !== serviceEpoch || active?.mode !== "profile" || active.id !== current.id || active.nonce !== current.nonce) throw new DOMException("Saved view change cancelled because the session changed.", "AbortError");
    const store = storage(); const key = workspaceKey(current.id);
    let workspaces = [];
    try { const value = readNamespaced(store, key, legacyWorkspaceKey(current.id)); if (value) workspaces = decodeWorkspaces(value, current.id); }
    catch (error) { throw new Error("Saved views could not be read; nothing was replaced. " + (error.message || "")); }
    const matching = workspaces.some((entry) => entry.name === name);
    if (!matching && workspaces.length >= 10) throw new Error("This profile has reached the 10-saved-view limit. Remove a view before saving another.");
    const next = [item, ...workspaces.filter((entry) => entry.name !== name)];
    try { store.setItem(key, JSON.stringify({ schema: SCHEMA, userId: current.id, workspaces: next })); }
    catch { throw new Error("This browser could not save the view. Check available storage and try again."); }
    return item;
  });
}

export async function deleteWorkspace(name) {
  const current = getSession();
  if (!current || current.mode !== "profile") throw new Error("Sign in to manage saved views on this browser.");
  const epoch = serviceEpoch;
  return withWorkspaceLock(() => {
    const active = getSession();
    if (epoch !== serviceEpoch || active?.mode !== "profile" || active.id !== current.id || active.nonce !== current.nonce) throw new DOMException("Saved view change cancelled because the session changed.", "AbortError");
    const store = storage(); const key = workspaceKey(current.id); const value = readNamespaced(store, key, legacyWorkspaceKey(current.id));
    if (!value) return false;
    const workspaces = decodeWorkspaces(value, current.id);
    const next = workspaces.filter((item) => item.name !== name);
    if (next.length === workspaces.length) return false;
    try { store.setItem(key, JSON.stringify({ schema: SCHEMA, userId: current.id, workspaces: next })); }
    catch { throw new Error("This browser could not update saved views. Existing views were kept."); }
    return true;
  });
}

export async function applyCloudCollection(collection, payload) {
  const current = getSession();
  if (current?.mode !== "profile") throw new Error("Log in to a local profile before applying synced settings.");
  const epoch = serviceEpoch;
  let serialized; let key;
  if (collection === "saved_views") {
    const workspaces = decodeWorkspaces(JSON.stringify({ schema: SCHEMA, userId: current.id, workspaces: payload }), current.id);
    serialized = JSON.stringify({ schema: SCHEMA, userId: current.id, workspaces }); key = workspaceKey(current.id);
  } else if (collection === "preferences") {
    if (!payload || !["light", "dark"].includes(payload.theme)) throw new Error("Cloud preferences are malformed.");
    serialized = JSON.stringify({ schema: SCHEMA, userId: current.id, theme: payload.theme }); key = preferencesKey(current.id);
  } else throw new Error("This local collection is not available for sync.");
  return withWorkspaceLock(() => {
    const active = getSession();
    if (epoch !== serviceEpoch || active?.mode !== "profile" || active.id !== current.id || active.nonce !== current.nonce) throw new DOMException("Cloud data application cancelled because the session changed.", "AbortError");
    try { storage().setItem(key, serialized); }
    catch { throw new Error("Cloud data could not be applied because browser storage is full. Existing local data was kept."); }
    return true;
  });
}

const BACKUP_MAX_BYTES = 1024 * 1024;
const BACKUP_SCHEMA = 1;
function backupPassphrase(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 1024) throw new Error("Use a backup passphrase between 12 and 1,024 characters.");
  return value;
}
async function deriveAesKey(passphrase, salt, usages) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, material,
    { name: "AES-GCM", length: 256 }, false, usages);
}
function assertJsonDepth(text, maxDepth = 12) {
  let depth = 0, inString = false, escaped = false;
  for (const char of text) {
    if (inString) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') inString = false; continue; }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") { if (++depth > maxDepth) throw new Error("Backup nesting exceeds the safety limit."); }
    else if (char === "}" || char === "]") { if (--depth < 0) throw new Error("Backup structure is malformed."); }
  }
  if (inString || depth !== 0) throw new Error("Backup structure is malformed.");
}
function exactB64(value, byteCount, label) {
  if (typeof value !== "string" || value.length > byteCount * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`Backup ${label} is malformed.`);
  const bytes = fromB64(value);
  if (bytes.length !== byteCount) throw new Error(`Backup ${label} has an unsupported length.`);
  return bytes;
}
function validateBackupData(data) {
  if (!data || data.schema !== SCHEMA || typeof data.email !== "string" || data.email.length > 254 || !EMAIL.test(data.email) ||
      !Array.isArray(data.workspaces) || data.workspaces.length > 10 || !data.preferences || !["light", "dark"].includes(data.preferences.theme)) {
    throw new Error("Backup contains unsupported or malformed profile data.");
  }
  const contextKeys = new Set(["screen", "check", "tab", "msg", "index", "page", "field"]);
  for (const item of data.workspaces) {
    const c = item?.context;
    if (!c || Object.getPrototypeOf(c) !== Object.prototype || Object.keys(c).some(key => !contextKeys.has(key)) ||
        c.screen !== undefined && !["capture", "frames", "details", "help"].includes(c.screen) ||
        c.check !== undefined && !["all", "issues", "crc", "unsupported", "valid"].includes(c.check) ||
        c.tab !== undefined && !["decoded", "bytes", "header"].includes(c.tab) ||
        ["msg", "index", "page"].some(key => c[key] !== undefined && c[key] !== null && (!Number.isSafeInteger(c[key]) || c[key] < (key === "page" ? 1 : 0) || c[key] > (key === "index" ? 999_999_999 : 1_000_000))) ||
        c.field !== undefined && c.field !== null && (typeof c.field !== "string" || !/^[A-Za-z0-9_.:[\]-]{1,128}$/.test(c.field))) throw new Error("Backup contains an unsupported saved view context.");
  }
  const workspaces = decodeWorkspaces(JSON.stringify({ schema: SCHEMA, userId: "backup-preview", workspaces: data.workspaces }), "backup-preview");
  return { email: data.email.toLowerCase(), workspaces, preferences: { theme: data.preferences.theme } };
}

export async function createEncryptedBackup(passphrase) {
  backupPassphrase(passphrase);
  const session = getSession();
  if (session?.mode !== "profile") throw new Error("Log in to a local profile before creating its backup.");
  const epoch = serviceEpoch;
  const profile = readProfile(session.id);
  const data = { schema: BACKUP_SCHEMA, email: profile.email, workspaces: loadWorkspace() || [], preferences: loadPreferences() || { theme: "light" } };
  const plain = encoder.encode(JSON.stringify(data));
  if (plain.length > 512 * 1024) throw new Error("Profile data exceeds the 512 KiB encrypted backup limit.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt, ["encrypt"]);
  if (epoch !== serviceEpoch) throw new DOMException("Backup cancelled because the session changed.", "AbortError");
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`mavframe-backup:${BACKUP_SCHEMA}`) }, key, plain);
  if (epoch !== serviceEpoch || getSession()?.id !== session.id || getSession()?.nonce !== session.nonce) throw new DOMException("Backup cancelled because the profile session changed.", "AbortError");
  return JSON.stringify({ appId: APP, version: 1, schema: BACKUP_SCHEMA,
    kdf: { algorithm: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: b64(salt) },
    cipher: { algorithm: "AES-GCM", tagBits: 128, iv: b64(iv), ciphertext: b64(ciphertext) } }, null, 2);
}

export async function previewEncryptedBackup(raw, passphrase) {
  const epoch = serviceEpoch;
  const current = () => { if (epoch !== serviceEpoch) throw new DOMException("Backup preview cancelled because the session changed.", "AbortError"); };
  backupPassphrase(passphrase);
  if (typeof raw !== "string" || raw.length > BACKUP_MAX_BYTES) throw new Error("Backup file exceeds the 1 MiB safety limit.");
  assertJsonDepth(raw);
  let envelope;
  try { envelope = JSON.parse(raw); } catch { throw new Error("Backup is not valid JSON."); }
  if (envelope?.appId !== APP || envelope.version !== 1 || envelope.schema !== BACKUP_SCHEMA ||
      envelope.kdf?.algorithm !== "PBKDF2" || envelope.kdf.hash !== "SHA-256" || envelope.kdf.iterations !== ITERATIONS ||
      envelope.cipher?.algorithm !== "AES-GCM" || envelope.cipher.tagBits !== 128) throw new Error("Backup app, version or cryptographic parameters are unsupported.");
  const salt = exactB64(envelope.kdf.salt, 16, "salt"), iv = exactB64(envelope.cipher.iv, 12, "IV");
  const ciphertext = fromB64(envelope.cipher.ciphertext);
  if (ciphertext.length < 16 || ciphertext.length > 600 * 1024) throw new Error("Encrypted backup data is outside the supported size range.");
  let plain;
  try {
    const key = await deriveAesKey(passphrase, salt, ["decrypt"]);
    current();
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`mavframe-backup:${BACKUP_SCHEMA}`) }, key, ciphertext);
  } catch (error) { current(); throw error.name === "AbortError" ? error : new Error("Backup could not be decrypted. Check the passphrase and file integrity."); }
  current();
  if (plain.byteLength > 512 * 1024) throw new Error("Decrypted profile data exceeds the 512 KiB limit.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(plain); assertJsonDepth(text);
  let data; try { data = JSON.parse(text); } catch { throw new Error("Decrypted profile data is malformed."); }
  const validated = validateBackupData(data);
  const newProfileSalt = crypto.getRandomValues(new Uint8Array(16));
  const newProfileVerifier = await derive(passphrase, newProfileSalt);
  current();
  const existingProfile = readIndex().find(item => item.email === validated.email);
  const active = getSession();
  const conflictCount = existingProfile && active?.mode === "profile" && active.id === existingProfile.id
    ? validated.workspaces.filter(item => (loadWorkspace() || []).some(current => current.name === item.name)).length : 0;
  const stageId = randomId();
  backupStages.set(stageId, { epoch, data: validated, credentials: { salt: b64(newProfileSalt), verifier: b64(newProfileVerifier) }, created: Date.now() });
  for (const [id, value] of backupStages) if (Date.now() - value.created > 5 * 60_000) backupStages.delete(id);
  while (backupStages.size > 3) backupStages.delete(backupStages.keys().next().value);
  return { stageId, email: validated.email, workspaceCount: validated.workspaces.length, existingProfile: !!existingProfile, conflictCount };
}

export async function commitEncryptedBackup(stageId, mode) {
  const staged = backupStages.get(stageId);
  if (!staged || staged.epoch !== serviceEpoch || Date.now() - staged.created > 5 * 60_000) throw new Error("Backup preview expired. Select and preview the file again.");
  if (!["restore", "merge"].includes(mode)) throw new Error("Choose restore or merge after reviewing the preview.");
  const data = staged.data; const records = readIndex(); let profile = records.find(item => item.email === data.email);
  if (profile && mode === "restore" && getSession()?.id !== profile.id) throw new Error("Log in to the matching local profile before replacing its saved settings.");
  if (profile && getSession()?.id !== profile.id) throw new Error("Log in to the matching local profile before merging saved settings.");
  if (!profile && mode === "merge") throw new Error("Merge is available only for an existing matching local profile.");
  const epoch = serviceEpoch;
  return withProfileIndexLock(() => withWorkspaceLock(async () => {
    if (epoch !== serviceEpoch || backupStages.get(stageId) !== staged) throw new DOMException("Backup restore cancelled because the session changed.", "AbortError");
    const store = storage(); const fresh = readIndex(); profile = fresh.find(item => item.email === data.email);
    const active = getSession();
    if (profile && active?.id !== profile.id) throw new Error("The matching profile session changed. Log in and preview again.");
    if (!profile && mode !== "restore") throw new Error("The matching profile changed. Preview again.");
    if (!profile && fresh.length >= 500) throw new Error("This browser has reached the 500-profile limit.");
    const id = profile?.id || randomId();
    let restoredWorkspaceCount = 0;
    const old = new Map([INDEX_KEY, profileKey(id), workspaceKey(id), preferencesKey(id), SESSION_KEY].map(key => [key, store.getItem(key)]));
    try {
      if (!profile) {
        const record = { schema: SCHEMA, id, email: data.email, createdAt: new Date().toISOString(), kdf: KDF_VERSION, iterations: ITERATIONS, salt: staged.credentials.salt, verifier: staged.credentials.verifier };
        store.setItem(profileKey(id), JSON.stringify(record));
        store.setItem(INDEX_KEY, JSON.stringify([...fresh, { id, email: data.email }]));
      }
      let workspaces = data.workspaces;
      if (mode === "merge") {
        const existing = loadWorkspace() || []; const names = new Set(existing.map(item => item.name));
        workspaces = [...existing, ...data.workspaces.filter(item => !names.has(item.name))];
        if (workspaces.length > 10) throw new Error("Merge would exceed the 10-view limit. Remove saved views and retry.");
      }
      restoredWorkspaceCount = workspaces.length;
      store.setItem(workspaceKey(id), JSON.stringify({ schema: SCHEMA, userId: id, workspaces }));
      store.setItem(preferencesKey(id), JSON.stringify({ schema: SCHEMA, userId: id, theme: mode === "merge" ? (loadPreferences()?.theme || data.preferences.theme) : data.preferences.theme }));
      if (!profile) writeSession({ schema: SCHEMA, mode: "profile", id, nonce: randomId() });
      if (epoch !== serviceEpoch) throw new DOMException("Backup restore cancelled because the session changed.", "AbortError");
    } catch (error) {
      for (const [key, value] of old) { try { if (value === null) store.removeItem(key); else store.setItem(key, value); } catch { /* retain original failure */ } }
      throw error;
    }
    backupStages.delete(stageId);
    if (!profile) { volatileSession = null; invalidatePrivateOperations(); }
    return { profileId: id, email: data.email, workspaceCount: restoredWorkspaceCount, createdProfile: !profile };
  }));
}
