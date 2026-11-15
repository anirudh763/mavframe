import { STATUS, classifySeq } from './core.js';

export const LIVE_RETAIN_BYTES = 8 * 1024 * 1024;
export const LIVE_SESSION_BYTES = 1024 * 1024 * 1024;

export function liveAnalyzer(parser) {
  const ring = new Uint8Array(LIVE_RETAIN_BYTES);
  const sequences = new Int16Array(65536).fill(-1);
  const rows = [];
  let written = 0, total = 0, gaps = 0, missing = 0, duplicates = 0, reorders = 0;
  let firstTime = null, lastTime = null;
  let finished = false;
  const x = parser.exports;
  x.mfw_reset();
  function take() {
    const n = x.mfw_event_count(), events = parser.events(n);
    for (let i = 0; i < n; i++) {
      const at = i * 16;
      const status = events.getUint8(at + 8), seq = events.getUint8(at + 9);
      const sysid = events.getUint8(at + 10), compid = events.getUint8(at + 11);
      if (status === STATUS.FRAME) {
        const key = sysid * 256 + compid;
        const previous = sequences[key];
        const change = previous < 0 ? { next: seq } : classifySeq(previous, seq);
        if (change.kind === 'gap') { gaps++; missing += change.missing; }
        if (change.kind === 'duplicate') duplicates++;
        if (change.kind === 'reorder') reorders++;
        sequences[key] = change.next;
      } else if (status === STATUS.UNKNOWN_MSGID) {
        const key = sysid * 256 + compid;
        if (sequences[key] >= 0 && ((seq - sequences[key]) & 255) === 1) sequences[key] = seq;
      }
      rows.push({ offset: events.getUint32(at, true), message: events.getUint32(at + 4, true), status, seq, sysid, compid });
      if (rows.length > 100) rows.shift();
    }
  }
  return {
    feed(bytes, arrivalMs) {
      if (finished) throw new Error('This live parser session has ended.');
      if (!(bytes instanceof Uint8Array) || bytes.length > 65536) throw new Error('Live reads must be at most 64 KiB.');
      if (total + bytes.length > LIVE_SESSION_BYTES) throw new Error('Live session reached 1 GiB. Disconnect and start a new capture.');
      if (!Number.isFinite(arrivalMs) || arrivalMs < 0 || (lastTime !== null && arrivalMs < lastTime)) throw new Error('Live arrival clock must be monotonic.');
      if (bytes.length) { firstTime ??= arrivalMs; lastTime = arrivalMs; }
      const first = Math.min(bytes.length, ring.length - written);
      ring.set(bytes.subarray(0, first), written);
      ring.set(bytes.subarray(first), 0);
      written = (written + bytes.length) % ring.length;
      total += bytes.length;
      parser.input().set(bytes);
      let used = 0;
      while (used < bytes.length) {
        const consumed = x.mfw_feed(used, bytes.length - used);
        take();
        if (!consumed && !x.mfw_event_count()) throw new Error('Native stream parser made no progress.');
        used += consumed;
      }
      return this.summary();
    },
    summary() {
      const stats = parser.stats();
      const elapsed = firstTime !== null && lastTime > firstTime ? (lastTime - firstTime) / 1000 : null;
      return { stats, gaps, missing_estimate: missing, duplicates, reorders, bytes: total, retained_bytes: Math.min(total, ring.length), discarded_history_bytes: Math.max(0, total - ring.length), elapsed_s: elapsed, rate_hz: elapsed && stats.frames > 1 ? (stats.frames - 1) / elapsed : null, clock: 'browser chunk-arrival monotonic clock; not device timestamps', recent: rows.slice(-20) };
    },
    snapshot() {
      if (!finished) {
        for (;;) { const done = x.mfw_flush(); take(); if (done) break; }
        finished = true;
      }
      const size = Math.min(total, ring.length), bytes = new Uint8Array(size);
      const start = total >= ring.length ? written : 0;
      const first = Math.min(size, ring.length - start);
      bytes.set(ring.subarray(start, start + first));
      if (first < size) bytes.set(ring.subarray(0, size - first), first);
      return { bytes, discarded: Math.max(0, total - size), summary: this.summary() };
    },
  };
}
