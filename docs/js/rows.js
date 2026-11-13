// Frames row model: every valid frame plus every candidate the parser
// rejected as a CRC failure, an unsupported message id or bad flags, in byte
// order. A row is addressed by its position k (the <index> in #/frames/<index>).
// Uses only what core.js's analyze() already returns; nothing is re-parsed.
import { frameAt } from "./core.js";

export const CANDIDATE_KINDS = new Set(["crc", "unsupported", "reject"]);
export const SEQ_KINDS = new Set(["gap", "duplicate", "reorder"]);

// Number of values in a sorted Int32Array that are < x (lower bound).
function lowerBound(a, x) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

// ref: { t: "f", i: frame index } or { t: "i", i: index into result.issues }.
export function rowIndex(r) {
  if (r._rowIndex) return r._rowIndex;
  const cand = [];
  r.issues.forEach((it, j) => { if (CANDIDATE_KINDS.has(it.kind) && it.frame <= r.frameCount) cand.push(j); });
  cand.sort((a, b) => r.issues[a].frame - r.issues[b].frame || r.issues[a].off - r.issues[b].off);
  // A candidate with .frame = n came after n valid frames, so it sits before frame n.
  const candFrame = Int32Array.from(cand, (j) => r.issues[j].frame);
  const candPos = Int32Array.from(cand, (j, k) => r.issues[j].frame + k);
  const candOf = new Map(cand.map((j, k) => [j, k]));
  const seqAt = new Map();
  for (const it of r.issues) if (SEQ_KINDS.has(it.kind) && it.frame < r.frameCount) seqAt.set(it.frame, it);
  const length = r.frameCount + cand.length;
  const idx = {
    length,
    at(k) {
      if (k < 0 || k >= length) return null;
      const c = lowerBound(candPos, k);
      if (c < candPos.length && candPos[c] === k) return { t: "i", i: cand[c] };
      return { t: "f", i: k - c };
    },
    positionOf(ref) {
      if (!ref) return -1;
      if (ref.t === "f") return ref.i >= 0 && ref.i < r.frameCount ? ref.i + lowerBound(candFrame, ref.i + 1) : -1;
      const c = candOf.get(ref.i);
      return c === undefined ? -1 : candPos[c];
    },
    seqIssue(frameIndex) { return seqAt.get(frameIndex) || null; },
  };
  Object.defineProperty(r, "_rowIndex", { value: idx, enumerable: false });
  return idx;
}

// Everything a row shows, for a frame or a rejected candidate.
export function rowInfo(r, ref) {
  if (ref.t === "f") {
    const f = frameAt(r, ref.i);
    return { ref, type: "frame", check: "valid", off: f.off, flen: f.flen, msgid: f.msgid, sysid: f.sysid, compid: f.compid,
      seq: f.seq, ts: f.ts, iflags: f.iflags, frame: f, seqIssue: rowIndex(r).seqIssue(ref.i), issue: null };
  }
  const it = r.issues[ref.i];
  return { ref, type: "issue", check: it.kind, off: it.off, flen: Math.min(it.flen, r.byteLength - it.off), msgid: it.msgid,
    sysid: it.sysid, compid: it.compid, seq: it.seq, ts: it.ts, iflags: it.iflags, frame: null, seqIssue: null, issue: it };
}

// Positions of the rows that pass a filter. check: all | valid | crc | unsupported | issues; msg: id or null.
// The unfiltered list of a large capture is not materialised.
export function filterRows(r, check = "all", msg = null) {
  const idx = rowIndex(r);
  if (check === "all" && msg === null) {
    return { length: idx.length, at: (k) => (k >= 0 && k < idx.length ? k : -1), indexOf: (p) => (p >= 0 && p < idx.length ? p : -1) };
  }
  const out = [];
  for (let k = 0; k < idx.length; k++) {
    const ref = idx.at(k);
    let kind;
    let msgid;
    if (ref.t === "f") { kind = "valid"; msgid = r.frames.msgid[ref.i]; } else { kind = r.issues[ref.i].kind; msgid = r.issues[ref.i].msgid; }
    if (msg !== null && msgid !== msg) continue;
    if (check === "valid" && kind !== "valid") continue;
    if (check === "crc" && kind !== "crc") continue;
    if (check === "unsupported" && kind !== "unsupported" && kind !== "reject") continue;
    if (check === "issues" && kind === "valid" && !idx.seqIssue(ref.i)) continue;
    out.push(k);
  }
  const arr = Int32Array.from(out);
  return { length: arr.length, at: (k) => (k >= 0 && k < arr.length ? arr[k] : -1), indexOf: (p) => { const i = lowerBound(arr, p); return arr[i] === p ? i : -1; } };
}

// Positions of rows that are issues (candidates or frames with a sequence note), for Previous/Next issue.
export function issuePositions(r) {
  if (r._issuePositions) return r._issuePositions;
  const idx = rowIndex(r);
  const out = [];
  r.issues.forEach((it, j) => {
    const p = CANDIDATE_KINDS.has(it.kind) ? idx.positionOf({ t: "i", i: j }) : idx.positionOf({ t: "f", i: it.frame });
    if (p >= 0) out.push(p);
  });
  const arr = Int32Array.from(new Set(out)).sort();
  Object.defineProperty(r, "_issuePositions", { value: arr, enumerable: false });
  return arr;
}
