// Portable finding export: one row of a capture as plain JSON that can be
// attached to a bug report. Raw payload bytes require an explicit opt-in:
// even a familiar message id can be damaged or carry unexpected data.
import { anatomy, hexN, msgLabel } from "./anatomy.js";
import { rowIndex, rowInfo } from "./rows.js";

// Must equal MAVFRAME_VERSION_STRING in include/mavframe.h (tests/web/test_finding.mjs checks).
export const MAVFRAME_VERSION = "0.1.0";

const KIND = { valid: "valid_frame", crc: "crc_failure", unsupported: "unsupported_message", reject: "bad_flags" };
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null; // not a secure context
  return hex(new Uint8Array(await subtle.digest("SHA-256", bytes)));
}

export const ASSUMPTIONS = [
  "Frames are found and CRC-checked by src/mavframe.c compiled to WebAssembly, with CRC_EXTRA values from the MAVLink common dialect.",
  "Message signatures are carried but not verified: a signature present does not mean the frame is authentic.",
  "Sequence gaps assume one fully observed channel per sender and in-order arrival; routing, filtering or merged links can create apparent loss.",
  "Message ids outside the common dialect are not checked (no CRC_EXTRA) and are reported as unsupported, not as corrupt.",
  "MAVLink v1 frames are not parsed and count as skipped bytes.",
];

export async function buildFinding({ result, bytes, parser, ref, fileName, isSample = false, includeAllPayloads = false }) {
  const info = rowInfo(result, ref);
  const a = anatomy(result, bytes, parser, info);
  if (result._sha256 === undefined) {
    Object.defineProperty(result, "_sha256", { value: await sha256Hex(bytes), enumerable: false });
  }
  const hs = info.ts;
  const rel = Number.isNaN(hs) || Number.isNaN(result.firstTs) ? null : Number(((hs - result.firstTs) / 1e6).toFixed(6));
  const finding = {
    row: rowIndex(result).positionOf(ref),
    kind: KIND[info.check],
    offset: info.off,
    frame_length: info.flen,
    time_s: rel,
    timestamp_us: Number.isNaN(hs) ? null : hs,
    message: { id: a.msgid, name: msgLabel(a.msgid) },
    sysid: info.sysid,
    compid: info.compid,
    seq: info.seq,
    incompat_flags: hexN(info.iflags, 2),
    signature: a.signed ? "present; not verified" : "absent",
    crc: a.crc ? { wire: hexN(a.crc.wire, 4), computed: a.crc.computed === null ? null : hexN(a.crc.computed, 4),
      match: a.crc.computed === null ? null : a.crc.computed === a.crc.wire } : null,
  };
  if (info.seqIssue) {
    const s = info.seqIssue;
    finding.sequence = { kind: s.kind, prev_seq: s.prevSeq, seq: s.seq, missing_estimate: s.missing || 0, note: "estimate; assumes one fully observed channel and in-order arrival" };
  }
  const out = { header_hex: hex(bytes.subarray(a.off, Math.min(a.off + 10, a.end))) };
  if (a.crc) out.crc_hex = hex(bytes.subarray(a.crc.at, a.crc.at + 2));
  const payload = bytes.subarray(a.off + 10, Math.min(a.off + 10 + a.plen, a.end));
  if (info.check === "unsupported" || info.check === "reject") {
    out.payload_omitted = `${a.plen} payload bytes declared; only the candidate header was retained. Payload boundaries are not established, so raw payload export is unavailable for this row.`;
  } else if (includeAllPayloads) {
    out.payload_hex = hex(payload);
  } else {
    out.payload_omitted = `${payload.length} payload bytes left out; raw payloads may contain GPS/position or other sensitive data. Export again with "Include all payloads" to add them.`;
  }
  return {
    schema: "mavframe-finding/1",
    tool: { name: "mavframe inspector", version: MAVFRAME_VERSION, parser: "src/mavframe.c compiled to WebAssembly" },
    file: { name: fileName, size: bytes.length, sha256: result._sha256, format: result.format, engineering_fixture: !!isSample },
    finding,
    bytes: out,
    assumptions: ASSUMPTIONS,
  };
}
