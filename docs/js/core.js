// Capture analysis for the mavframe inspector. Runs in the browser and in
// Node (tests/web/). All frame finding and CRC checking is done by the C
// parser (src/mavframe.c) compiled to mavframe.wasm; this file only collects
// its events, attaches .tlog timestamps, tracks sequence numbers and decodes
// payload fields for display.
import { MESSAGE_NAMES, MESSAGES, ENUMS } from "./msgdefs.js";

export const STATUS = { FRAME: 1, BAD_CRC: 2, UNKNOWN_MSGID: 3, BAD_FLAGS: 4 };
// Memory bounds. A capture is held in memory once; frame details take 23
// bytes each and are kept for the first MAX_LISTED_FRAMES frames, issue
// details for the first MAX_LISTED_ISSUES issues. Counts always cover all.
export const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
export const MAX_LISTED_FRAMES = 4000000;
export const MAX_LISTED_ISSUES = 100000;
const EVENT_SIZE = 16;
const TS_MIN_US = 946684800e6; // 2000-01-01
const TS_MAX_US = 4102444800e6; // 2100-01-01

export function messageName(msgid) {
  return MESSAGE_NAMES[msgid] || null;
}

// Wrap an instantiated mavframe.wasm.
export function wrapParser(instance) {
  const x = instance.exports;
  const mem = x.memory;
  return {
    exports: x,
    inputCap: x.mfw_input_cap(),
    input() { return new Uint8Array(mem.buffer, x.mfw_input(), this.inputCap); },
    events(n) { return new DataView(mem.buffer, x.mfw_events(), n * EVENT_SIZE); },
    stats() {
      const v = new Uint32Array(mem.buffer, x.mfw_stats(), 6);
      return { bytes: v[0], frames: v[1], bad_crc: v[2], unknown_msgid: v[3], bad_flags: v[4], dropped_bytes: v[5] };
    },
    // CRC of a frame (bytes 1..9 + payload + CRC_EXTRA) computed by the C code.
    // Returns null when the message id has no CRC_EXTRA.
    crc(frame) {
      const plen = frame[1];
      const scratch = new Uint8Array(mem.buffer, x.mfw_scratch(), 280);
      const n = Math.min(9 + plen, frame.length - 1, 279);
      scratch.set(frame.subarray(1, 1 + n), 0);
      const msgid = frame[7] | (frame[8] << 8) | (frame[9] << 16);
      if (!x.mavframe_crc_extra(msgid, x.mfw_scratch() + 279)) return null;
      let crc = x.mavframe_crc16(0xffff, x.mfw_scratch(), n);
      crc = x.mavframe_crc16(crc, x.mfw_scratch() + 279, 1);
      return crc & 0xffff;
    },
  };
}

export async function loadParser(source) {
  let result;
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    result = await WebAssembly.instantiate(source, {});
  } else {
    const resp = await fetch(source);
    if (!resp.ok) throw new Error(`could not load ${source}: HTTP ${resp.status}`);
    result = await WebAssembly.instantiate(await resp.arrayBuffer(), {});
  }
  return wrapParser(result.instance);
}

function readTs(bytes, off) {
  // 8-byte big-endian microseconds; exact up to 2^53.
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 4; i++) hi = hi * 256 + bytes[off + i];
  for (let i = 4; i < 8; i++) lo = lo * 256 + bytes[off + i];
  return hi * 4294967296 + lo;
}

function plausibleTs(us) {
  return us >= TS_MIN_US && us <= TS_MAX_US;
}

// "tlog" when the name says so, or when the file starts like one: a
// timestamp in 2000..2100 followed by a MAVLink start byte.
export function detectFormat(bytes, name = "") {
  if (/\.tlog$/i.test(name)) return "tlog";
  if (bytes.length >= 9 && (bytes[8] === 0xfd || bytes[8] === 0xfe) && plausibleTs(readTs(bytes, 0))) return "tlog";
  return "raw";
}

class Growable {
  constructor(Type, n = 4096) { this.Type = Type; this.a = new Type(n); }
  ensure(n) {
    if (n <= this.a.length) return;
    const b = new this.Type(Math.max(n, this.a.length * 2));
    b.set(this.a);
    this.a = b;
  }
}

export function abortError() {
  const e = new Error("cancelled");
  e.name = "AbortError";
  return e;
}

function defaultYield() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/*
 * Sequence numbers are 8 bits and wrap (255 -> 0 is in order). For one
 * (system, component) the step d = (seq - prev) mod 256 is read as:
 *   d = 1          in order
 *   d = 0          duplicate (same seq again)
 *   d = 2..128     gap: about d-1 frames missing *if* frames arrive in
 *                  order; a late or reordered frame looks the same, so the
 *                  number is an estimate, not a count of lost frames
 *   d = 129..255   a step back by 256-d: a late (out-of-order) frame when
 *                  the step is small (<= 16; the expected position is kept),
 *                  otherwise more likely a sender restart/reset (tracking
 *                  continues from the new value)
 * Returns { kind: "next"|"duplicate"|"gap"|"reorder", next: seq to compare
 * the following frame with, missing?, back?, reset? }.
 */
export const SEQ_LATE_MAX_BACK = 16;
export function classifySeq(prev, seq) {
  const d = (seq - prev) & 0xff;
  if (d === 1) return { kind: "next", next: seq };
  if (d === 0) return { kind: "duplicate", next: prev };
  if (d <= 128) return { kind: "gap", next: seq, missing: d - 1 };
  const back = 256 - d;
  return back <= SEQ_LATE_MAX_BACK ? { kind: "reorder", next: prev, back, reset: false } : { kind: "reorder", next: seq, back, reset: true };
}

/*
 * Analyse a capture. bytes: Uint8Array. Returns a plain result object (see
 * the end of the function). Progress is reported after each chunk and
 * control is handed back with opts.yieldFn so a browser stays responsive.
 *
 * In .tlog mode, a rejected candidate that starts inside the 8 timestamp
 * bytes right before a valid frame or a CRC-failed frame is a timestamp byte
 * that happened to be 0xFD, not a link error; such events are counted as timestampArtifacts
 * instead of CRC errors / rejects.
 *
 * Issue kinds: "crc" (checksum mismatch: corrupted), "unsupported" (message
 * id without CRC_EXTRA in the common dialect: another dialect or noise; the
 * checksum cannot be checked, so it is not called corrupt), "reject"
 * (incompat flags other than "signed"), and three sequence-number findings
 * per (system, component), see classifySeq(): "gap", "duplicate", "reorder".
 *
 * opts.signal (an AbortSignal) cancels between chunks with an AbortError.
 */
export async function analyze(bytes, opts = {}) {
  const parser = opts.parser;
  const format = opts.format || detectFormat(bytes, opts.name);
  const tlog = format === "tlog";
  const chunk = Math.min(opts.chunkSize || 512 * 1024, parser.inputCap);
  const onProgress = opts.onProgress || (() => {});
  const yieldFn = opts.yieldFn || defaultYield;
  if (bytes.length > MAX_CAPTURE_BYTES) throw new Error(`capture larger than ${MAX_CAPTURE_BYTES / 1048576} MB`);
  const maxFrames = opts.maxFrames ?? MAX_LISTED_FRAMES;
  let validFrames = 0;

  const off = new Growable(Uint32Array);
  const msgid = new Growable(Uint32Array);
  const ts = new Growable(Float64Array);
  const hdr = new Growable(Uint8Array, 4096 * 5); // seq, sysid, compid, len, iflags
  const flen = new Growable(Uint16Array);
  let n = 0;

  // Issue details are kept for the first maxIssues issues only; the counts
  // always cover all of them. Without the cap a hostile capture (a fake
  // header every 10 bytes) would create millions of objects and exhaust the
  // tab's memory.
  const maxIssues = opts.maxIssues ?? MAX_LISTED_ISSUES;
  const issues = []; // {kind, off, msgid, sysid, compid, seq, ts, frame, ...}
  const counts = { crc: 0, unsupported: 0, reject: 0, gap: 0, duplicate: 0, reorder: 0 };
  let missingFrames = 0;
  let unlisted = 0;
  const pending = []; // .tlog: rejections that may still turn out to be timestamp bytes
  const messages = new Map();
  const lastSeq = new Int16Array(65536).fill(-1);
  let timestampArtifacts = 0;
  let insideFailedFrame = 0;
  let failedStart = -1;
  let failedEnd = -1;
  let framesWithTs = 0;
  let lastTs = NaN;

  function msgEntry(id) {
    let m = messages.get(id);
    if (!m) {
      m = { msgid: id, name: messageName(id), count: 0, crcErrors: 0, firstTs: NaN, lastTs: NaN, sources: new Map() };
      messages.set(id, m);
    }
    return m;
  }

  function tsBefore(o) {
    if (!tlog || o < 8) return NaN;
    const t = readTs(bytes, o - 8);
    return plausibleTs(t) ? t : NaN;
  }

  function commit(it, listable = true) {
    counts[it.kind]++;
    if (it.kind === "crc") msgEntry(it.msgid).crcErrors++;
    if (it.kind === "gap") missingFrames += it.missing;
    if (listable && issues.length < maxIssues) issues.push(it);
    else unlisted++;
  }

  function onEvents(count) {
    const v = parser.events(count);
    for (let i = 0; i < count; i++) {
      const b = i * EVENT_SIZE;
      const e = {
        off: v.getUint32(b, true), msgid: v.getUint32(b + 4, true), status: v.getUint8(b + 8),
        seq: v.getUint8(b + 9), sysid: v.getUint8(b + 10), compid: v.getUint8(b + 11),
        len: v.getUint8(b + 12), iflags: v.getUint8(b + 13), flen: v.getUint16(b + 14, true),
      };
      if (e.status !== STATUS.FRAME) {
        const own = tsBefore(e.off);
        const kind = e.status === STATUS.BAD_CRC ? "crc" : e.status === STATUS.UNKNOWN_MSGID ? "unsupported" : "reject";
        const it = { kind, status: e.status, off: e.off,
          msgid: e.msgid, sysid: e.sysid, compid: e.compid, seq: e.seq, len: e.len, flen: e.flen, iflags: e.iflags,
          ts: Number.isNaN(own) ? lastTs : own, frame: n };
        // After a CRC failure the parser rescans that frame's bytes for
        // another 0xFD. Candidates it rejects there are pieces of the damaged
        // frame, already reported as one CRC error, not separate issues.
        if (kind !== "crc" && e.off > failedStart && e.off < failedEnd) { insideFailedFrame++; continue; }
        if (kind === "crc") { failedStart = e.off; failedEnd = e.off + e.flen; }
        if (!tlog) { commit(it); continue; }
        // Events arrive in stream order, so the next frame starts after
        // e.off: older pending rejections can no longer sit in its timestamp.
        while (pending.length && pending[0].off < e.off - 8) commit(pending.shift());
        if (e.status === STATUS.BAD_CRC) {
          // A CRC failure is a whole candidate frame with a plausible header,
          // like a valid frame: rejections that began in the 8 bytes before
          // it were 0xFD bytes in its record's timestamp, not link errors.
          for (const p of pending) {
            if (p.kind !== "crc" && p.off >= e.off - 8) { p.artifact = true; timestampArtifacts++; }
          }
          for (let k = pending.length - 1; k >= 0; k--) if (pending[k].artifact) pending.splice(k, 1);
        }
        pending.push(it);
        continue;
      }
      // Rejections that began in this frame's 8 timestamp bytes were a 0xFD
      // inside the timestamp, not a link error.
      for (const it of pending) {
        if (it.off >= e.off - 8) timestampArtifacts++;
        else commit(it);
      }
      pending.length = 0;
      const t = tsBefore(e.off);
      if (!Number.isNaN(t)) { framesWithTs++; lastTs = t; }
      const key = (e.sysid << 8) | e.compid;
      const prev = lastSeq[key];
      const c = prev >= 0 ? classifySeq(prev, e.seq) : { kind: "first", next: e.seq };
      if (c.kind !== "next" && c.kind !== "first") {
        commit({ kind: c.kind, off: e.off, msgid: e.msgid, sysid: e.sysid, compid: e.compid, seq: e.seq,
          prevSeq: prev, missing: c.missing || 0, back: c.back || 0, reset: !!c.reset, ts: t, frame: n }, n < maxFrames);
      }
      lastSeq[key] = c.next;

      validFrames++;
      if (n < maxFrames) {
        off.ensure(n + 1); msgid.ensure(n + 1); ts.ensure(n + 1); flen.ensure(n + 1); hdr.ensure(5 * n + 5);
        off.a[n] = e.off; msgid.a[n] = e.msgid; ts.a[n] = t; flen.a[n] = e.flen;
        hdr.a.set([e.seq, e.sysid, e.compid, e.len, e.iflags], 5 * n);
        n++;
      }
      const m = msgEntry(e.msgid);
      m.count++;
      let src = m.sources.get(key);
      if (!src) m.sources.set(key, (src = { count: 0, firstTs: NaN, lastTs: NaN }));
      src.count++;
      if (!Number.isNaN(t)) {
        if (Number.isNaN(m.firstTs)) m.firstTs = t;
        m.lastTs = t;
        if (Number.isNaN(src.firstTs)) src.firstTs = t;
        src.lastTs = t;
      }
    }
  }

  const x = parser.exports;
  x.mfw_reset();
  for (let pos = 0; pos < bytes.length; pos += chunk) {
    const len = Math.min(chunk, bytes.length - pos);
    parser.input().set(bytes.subarray(pos, pos + len), 0);
    let used = 0;
    while (used < len) {
      const k = x.mfw_feed(used, len - used);
      const count = x.mfw_event_count();
      onEvents(count);
      if (k === 0 && count === 0) throw new Error("parser made no progress"); // cannot happen; guards a hang
      used += k;
    }
    onProgress(pos + len, bytes.length);
    if (pos + len < bytes.length) await yieldFn();
    if (opts.signal?.aborted) throw abortError();
  }
  for (;;) {
    const done = x.mfw_flush();
    onEvents(x.mfw_event_count());
    if (done) break;
  }
  for (const it of pending) commit(it);
  if (bytes.length === 0) onProgress(0, 0);

  const stats = parser.stats();
  let firstTs = NaN;
  let endTs = NaN;
  for (let i = 0; i < n; i++) if (!Number.isNaN(ts.a[i])) { firstTs = ts.a[i]; break; }
  endTs = lastTs;
  const msgList = [...messages.values()].sort((a, b) => a.msgid - b.msgid);
  for (const m of msgList) {
    const rate = (count, first, last) => (count > 1 && last > first ? ((count - 1) * 1e6) / (last - first) : NaN);
    // rateHz covers all senders of this message together; each source has its own.
    m.rateHz = rate(m.count, m.firstTs, m.lastTs);
    m.sources = [...m.sources].sort((a, b) => a[0] - b[0]).map(([k, v]) =>
      ({ sysid: k >> 8, compid: k & 0xff, count: v.count, rateHz: rate(v.count, v.firstTs, v.lastTs) }));
  }
  return {
    format,
    bytes,
    byteLength: bytes.length,
    frameCount: n, // frames with details kept (the first maxFrames)
    validFrames, // all frames with a valid CRC
    unlistedFrames: validFrames - n,
    frames: {
      off: off.a.subarray(0, n), msgid: msgid.a.subarray(0, n), ts: ts.a.subarray(0, n),
      flen: flen.a.subarray(0, n), hdr: hdr.a.subarray(0, 5 * n),
    },
    issues,
    unlistedIssues: unlisted,
    messages: msgList,
    crcErrors: counts.crc,
    unsupported: counts.unsupported,
    rejects: counts.reject,
    gaps: counts.gap,
    missingFrames, // estimate: assumes frames of one component arrive in order
    duplicates: counts.duplicate,
    reorders: counts.reorder,
    timestampArtifacts,
    insideFailedFrame, // rejected candidates inside a CRC-failed frame (not listed)
    skippedBytes: stats.dropped_bytes - (tlog ? 8 * framesWithTs : 0),
    firstTs,
    endTs,
    stats,
  };
}

// Low-level: feed bytes to the wasm glue in the given read sizes (each at
// most inputCap) and return every recorded event plus the parser counters.
// Used by the tests to compare the wasm and native builds event by event.
export function rawEvents(parser, bytes, reads) {
  const x = parser.exports;
  const out = [];
  const take = () => {
    const v = parser.events(x.mfw_event_count());
    for (let i = 0; i < x.mfw_event_count(); i++) {
      const b = i * EVENT_SIZE;
      out.push([v.getUint32(b, true), v.getUint32(b + 4, true), v.getUint8(b + 8), v.getUint8(b + 9), v.getUint8(b + 10),
        v.getUint8(b + 11), v.getUint8(b + 12), v.getUint8(b + 13), v.getUint16(b + 14, true)]);
    }
  };
  x.mfw_reset();
  let pos = 0;
  for (const r of reads) {
    if (r > parser.inputCap) throw new Error("read larger than the input buffer");
    parser.input().set(bytes.subarray(pos, pos + r), 0);
    let used = 0;
    while (used < r) {
      used += x.mfw_feed(used, r - used);
      take();
    }
    pos += r;
  }
  for (;;) {
    const done = x.mfw_flush();
    take();
    if (done) break;
  }
  return { events: out, stats: parser.stats() };
}

// One frame of a result as an object.
export function frameAt(r, i) {
  const h = r.frames.hdr;
  return {
    index: i, off: r.frames.off[i], msgid: r.frames.msgid[i], ts: r.frames.ts[i], flen: r.frames.flen[i],
    seq: h[5 * i], sysid: h[5 * i + 1], compid: h[5 * i + 2], len: h[5 * i + 3], iflags: h[5 * i + 4],
  };
}

const READERS = {
  uint8_t: [1, (v, o) => v.getUint8(o)], int8_t: [1, (v, o) => v.getInt8(o)],
  uint16_t: [2, (v, o) => v.getUint16(o, true)], int16_t: [2, (v, o) => v.getInt16(o, true)],
  uint32_t: [4, (v, o) => v.getUint32(o, true)], int32_t: [4, (v, o) => v.getInt32(o, true)],
  uint64_t: [8, (v, o) => v.getBigUint64(o, true)], int64_t: [8, (v, o) => v.getBigInt64(o, true)],
  float: [4, (v, o) => v.getFloat32(o, true)], double: [8, (v, o) => v.getFloat64(o, true)],
  char: [1, (v, o) => v.getUint8(o)],
};

export function hasDecoder(msgid) {
  return Object.prototype.hasOwnProperty.call(MESSAGES, msgid);
}

// Decode a payload with the layout from the official XML. MAVLink v2 trims
// trailing zero bytes, so the payload is padded back to full length first.
// 64-bit integers come back as BigInt.
export function decodePayload(msgid, payload) {
  if (!hasDecoder(msgid)) return null;
  const def = MESSAGES[msgid];
  const full = new Uint8Array(Math.max(def.length, payload.length));
  full.set(payload);
  const v = new DataView(full.buffer);
  const fields = def.fields.map((f) => {
    const [size, read] = READERS[f.type];
    let value;
    if (f.type === "char") {
      let s = "";
      for (let i = 0; i < f.count; i++) {
        const c = full[f.offset + i];
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      value = s;
    } else if (f.count) {
      value = [];
      for (let i = 0; i < f.count; i++) value.push(read(v, f.offset + i * size));
    } else {
      value = read(v, f.offset);
    }
    return { ...f, value, meaning: meaning(f, value) };
  });
  return { msgid, name: def.name, description: def.description, length: def.length, trimmed: payload.length < def.length, fields };
}

function enumMeaning(name, value) {
  const e = ENUMS[name];
  if (!e || typeof value !== "number") return "";
  if (!e.bitmask) return e.entries[value] || "";
  const set = Object.keys(e.entries).map(Number).filter((bit) => bit && (value & bit) === bit);
  return set.length ? set.map((bit) => e.entries[bit]).join(" | ") : "none";
}

function fixed(x, d) {
  return Number(x).toFixed(d);
}

// Human-readable reading of a raw field value (empty when the raw value says it all).
export function meaning(f, value) {
  if (f.invalid !== undefined && value === f.invalid) return "not provided";
  if (f.enum) return enumMeaning(f.enum, value);
  if (typeof value !== "number") return "";
  switch (f.units) {
    case "degE7": return `${fixed(value / 1e7, 7)}°`;
    case "cdeg": return `${fixed(value / 100, 2)}°`;
    case "rad": return `${fixed((value * 180) / Math.PI, 2)}°`;
    case "rad/s": return `${fixed((value * 180) / Math.PI, 2)}°/s`;
    case "mm": return `${fixed(value / 1000, 3)} m`;
    case "cm/s": return `${fixed(value / 100, 2)} m/s`;
    case "mV": return `${fixed(value / 1000, 3)} V`;
    case "cA": return `${fixed(value / 100, 2)} A`;
    case "d%": return `${fixed(value / 10, 1)} %`;
    case "c%": return `${fixed(value / 100, 2)} %`;
    default: return "";
  }
}

export function formatValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (typeof value === "number" && !Number.isInteger(value)) return String(Number(value.toPrecision(7)));
  return String(value);
}
