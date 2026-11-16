const APP = "mavframe";
const COLLECTIONS = new Set(["saved_views", "preferences"]);
const MAX_RESPONSE = 64 * 1024;
const MAX_PAYLOAD = 48 * 1024;
const ALLOWED_CONTEXT = new Set(["screen", "check", "tab", "msg", "index", "page", "field"]);

function validatePayload(collection, value) {
  if (collection === "preferences") {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 1 || !["light", "dark"].includes(value.theme)) throw new Error("Theme sync payload is malformed.");
    return { theme: value.theme };
  }
  if (!Array.isArray(value) || value.length > 10) throw new Error("Saved-view sync accepts at most 10 view settings.");
  return value.map(item => {
    if (!item || Object.getPrototypeOf(item) !== Object.prototype || Object.keys(item).some(key => !["name", "savedAt", "context", "theme"].includes(key)) ||
        typeof item.name !== "string" || !item.name.trim() || item.name.length > 80 || typeof item.savedAt !== "string" || item.savedAt.length > 64 ||
        !["light", "dark"].includes(item.theme) || !item.context || Object.getPrototypeOf(item.context) !== Object.prototype || Object.keys(item.context).some(key => !ALLOWED_CONTEXT.has(key))) throw new Error("Saved-view sync payload contains unsupported or malformed data.");
    const context = { ...item.context };
    if (context.screen !== undefined && !["capture", "frames", "details", "help"].includes(context.screen)) throw new Error("Saved-view sync route is unsupported.");
    if (context.check !== undefined && !["all", "issues", "crc", "unsupported", "valid"].includes(context.check)) throw new Error("Saved-view sync filter is unsupported.");
    if (context.tab !== undefined && !["decoded", "bytes", "header"].includes(context.tab)) throw new Error("Saved-view sync tab is unsupported.");
    for (const key of ["msg", "index", "page"]) if (context[key] !== undefined && context[key] !== null && (!Number.isSafeInteger(context[key]) || context[key] < 0 || context[key] > 1_000_000_000)) throw new Error("Saved-view sync contains an invalid numeric selection.");
    if (context.field !== undefined && context.field !== null && (typeof context.field !== "string" || context.field.length > 128 || !/^[A-Za-z0-9_.:[\]-]+$/.test(context.field))) throw new Error("Saved-view sync contains an invalid field selection.");
    return { name: item.name, savedAt: item.savedAt, context, theme: item.theme };
  });
}

export function createSyncProvider({ projectUrl, anonKey, fetchImpl = fetch, isOnline = () => navigator.onLine } = {}) {
  let base, key, token = null, userId = null, generation = 0;
  const pendingRequests = new Set();
  const validateCollection = collection => { if (!COLLECTIONS.has(collection)) throw new Error("This collection is outside the Mavframe sync allowlist."); };
  const readJson = async response => {
    let text = "";
    if (response.body?.getReader) {
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error("Sync receiver response exceeded the 64 KiB safety limit."); }
        chunks.push(value);
      }
      const merged = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
      text = new TextDecoder("utf-8", { fatal: true }).decode(merged);
    } else { text = await response.text(); if (text.length > MAX_RESPONSE) throw new Error("Sync receiver response exceeded the 64 KiB safety limit."); }
    if (!response.ok) throw new Error(`Sync receiver returned HTTP ${response.status}.`);
    try { return text ? JSON.parse(text) : null; } catch { throw new Error("Sync receiver returned malformed JSON."); }
  };
  const request = async (path, options, epoch) => {
    if (!isOnline()) throw new Error("Offline edits remain on this device until you reconnect and sync.");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
    pendingRequests.add(controller);
    try {
      const response = await fetchImpl(new URL(path, base), { ...options, signal: controller.signal, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
      const data = await readJson(response);
      if (epoch !== generation) throw new DOMException("Cloud sync result ignored because its session ended.", "AbortError");
      return data;
    } finally { clearTimeout(timer); pendingRequests.delete(controller); }
  };
  async function connect(email, password) {
    if (!projectUrl || typeof anonKey !== "string" || !anonKey || anonKey.length > 4096) throw new Error("Enter the Supabase project URL and public anon or publishable key. Never use a secret/service-role key.");
    if (anonKey.startsWith("sb_secret_")) throw new Error("Supabase secret keys are never accepted in the browser. Use a public publishable or legacy anon key.");
    if (typeof email !== "string" || !email.trim() || email.length > 254 || typeof password !== "string" || !password || password.length > 1024) throw new Error("Enter a cloud account email and password within the supported size limits.");
    try { const payload = anonKey.split(".")[1]; if (payload && JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).role === "service_role") throw new Error("A service-role key is not accepted in the browser."); } catch (error) { if (/service-role/.test(error.message)) throw error; }
    try { base = new URL(projectUrl); } catch { throw new Error("Enter a valid Supabase project URL."); }
    if ((base.protocol !== "https:" && !(["localhost", "127.0.0.1"].includes(base.hostname) && base.protocol === "http:")) || base.username || base.password || base.search || base.hash) throw new Error("Sync requires an HTTPS Supabase URL without credentials or fragments.");
    base.pathname = base.pathname.replace(/\/$/, "") + "/";
    key = anonKey;
    token = null; userId = null;
    const epoch = ++generation;
    const result = await request("auth/v1/token?grant_type=password", {
      method: "POST", headers: { apikey: key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: email.trim(), password }),
    }, epoch);
    if (typeof result?.access_token !== "string" || result.access_token.length > 8192 || typeof result.user?.id !== "string" || !/^[0-9a-f-]{36}$/i.test(result.user.id)) throw new Error("Supabase did not return a valid authenticated user session.");
    token = result.access_token; userId = result.user.id;
    return { userId, expiresIn: Number.isFinite(result.expires_in) ? result.expires_in : null };
  }
  function logout() { generation++; token = null; userId = null; for (const controller of pendingRequests) controller.abort(); pendingRequests.clear(); }
  function requireSession() { if (!token || !userId) throw new Error("Connect to the cloud provider before syncing."); }
  async function syncCollection(collection, localValue, decision = null) {
    validateCollection(collection); requireSession();
    const epoch = generation;
    const rawEncoded = JSON.stringify(localValue);
    if (typeof rawEncoded !== "string" || rawEncoded.length > MAX_PAYLOAD) throw new Error("This sync collection exceeds the 48 KiB payload limit.");
    const cleanLocal = validatePayload(collection, localValue);
    const encoded = JSON.stringify(cleanLocal);
    if (encoded.length > MAX_PAYLOAD) throw new Error("This sync collection exceeds the 48 KiB payload limit.");
    const rows = await request(`rest/v1/mavframe_sync?select=owner_id,collection,revision,payload&owner_id=eq.${encodeURIComponent(userId)}&collection=eq.${encodeURIComponent(collection)}`, {
      headers: { apikey: key, Authorization: `Bearer ${token}`, Accept: "application/json" },
    }, epoch);
    if (!Array.isArray(rows) || rows.length > 1 || rows.some(row => row.owner_id !== userId || row.collection !== collection || !Number.isSafeInteger(row.revision) || row.revision < 1)) throw new Error("Sync receiver returned an invalid or cross-account collection response.");
    const remote = rows[0] || null;
    const cleanRemote = remote ? validatePayload(collection, remote.payload) : null;
    if (remote && JSON.stringify(cleanRemote) === encoded) return { status: "current", revision: remote.revision };
    if (decision === "use-remote") return { status: "use-remote", revision: remote?.revision ?? 0, payload: cleanRemote };
    if (!remote && decision !== "upload-local") return { status: "pending-upload", revision: 0 };
    if (remote && decision !== "upload-local") return { status: "conflict", revision: remote.revision, payload: remote.payload };
    const saved = await request("rest/v1/rpc/mavframe_sync_put", {
      method: "POST", headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_collection: collection, p_expected_revision: remote?.revision ?? 0, p_payload: cleanLocal }),
    }, epoch);
    const record = Array.isArray(saved) ? saved[0] : saved;
    if (!record || record.owner_id !== userId || record.collection !== collection || !Number.isSafeInteger(record.revision) || record.revision <= (remote?.revision ?? 0)) throw new Error("Sync write was not acknowledged with a newer revision. Local data remains unchanged and pending.");
    return { status: "synced", revision: record.revision };
  }
  async function deleteCollection(collection, expectedRevision) {
    validateCollection(collection); requireSession();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("Choose a current remote revision before deleting synced data.");
    const epoch = generation;
    const result = await request("rest/v1/rpc/mavframe_sync_delete", {
      method: "POST", headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_collection: collection, p_expected_revision: expectedRevision }),
    }, epoch);
    if (!(result === true || result?.deleted === true)) throw new Error("Remote deletion was not acknowledged; local data remains unchanged.");
    return { status: "deleted" };
  }
  return Object.freeze({ appId: APP, connect, logout, syncCollection, deleteCollection, get connected() { return Boolean(token && userId); } });
}
