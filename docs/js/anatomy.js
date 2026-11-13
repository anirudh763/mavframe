// Field-level anatomy of one row: every header, payload, CRC and signature
// field with the absolute byte range it occupies, for the linked field tree
// and hex panes and for the finding export. Bytes come from the capture; the
// CRC is computed by mavframe_crc16() in the WebAssembly module.
import { decodePayload, formatValue, messageName } from "./core.js";

export const hexN = (v, n) => "0x" + v.toString(16).toUpperCase().padStart(n, "0");
export const msgLabel = (id) => messageName(id) || `id ${id}`;

// CRC as sent on the wire and as computed over the frame; null when the frame
// is cut short, computed null when the message id has no CRC_EXTRA.
export function crcOf(bytes, parser, off) {
  const plen = bytes[off + 1];
  const c = off + 10 + plen;
  if (c + 2 > bytes.length) return null;
  const wire = bytes[c] | (bytes[c + 1] << 8);
  const computed = parser.crc(bytes.subarray(off, c + 2));
  return { wire, computed, at: c };
}

export function anatomy(result, bytes, parser, info) {
  const off = info.off;
  const b = bytes;
  const plen = b[off + 1];
  const iflags = b[off + 2];
  const signed = (iflags & 1) === 1;
  const msgid = b[off + 7] | (b[off + 8] << 8) | (b[off + 9] << 16);
  const end = Math.min(bytes.length, off + info.flen);
  const groups = [];
  const F = (key, name, from, to, value, reading = "", units = "") => ({ key, name, from, to: Math.min(to, end), value, reading, units });

  if (result.format === "tlog" && off >= 8) {
    let us = 0;
    for (let i = 0; i < 8; i++) us = us * 256 + b[off - 8 + i];
    const iso = us >= 946684800e6 && us <= 4102444800e6 ? new Date(us / 1000).toISOString() : "not a plausible time";
    groups.push({ id: "ts", title: "tlog record", fields: [F("ts", "tlog timestamp", off - 8, off, `${us} µs`, iso)] });
  }
  groups.push({ id: "header", title: "Header", fields: [
    F("stx", "Start byte", off, off + 1, hexN(b[off], 2), "MAVLink v2"),
    F("len", "Payload length", off + 1, off + 2, String(plen), "bytes"),
    F("incompat", "Incompat flags", off + 2, off + 3, hexN(iflags, 2), signed ? "signature present; not verified" : ""),
    F("compat", "Compat flags", off + 3, off + 4, hexN(b[off + 3], 2)),
    F("seq", "Sequence", off + 4, off + 5, String(b[off + 4])),
    F("sysid", "System ID", off + 5, off + 6, String(b[off + 5])),
    F("compid", "Component ID", off + 6, off + 7, String(b[off + 6])),
    F("msgid", "Message ID", off + 7, off + 10, String(msgid), msgLabel(msgid)),
  ] });

  const p0 = off + 10;
  const payload = b.subarray(p0, Math.min(p0 + plen, end));
  let decoded = null;
  if (info.check === "valid") decoded = decodePayload(msgid, payload);
  if (decoded) {
    const fields = decoded.fields.map((f) => {
      const size = { uint8_t: 1, int8_t: 1, char: 1, uint16_t: 2, int16_t: 2, uint32_t: 4, int32_t: 4, float: 4, uint64_t: 8, int64_t: 8, double: 8 }[f.type];
      const from = p0 + f.offset;
      const to = from + size * (f.count || 1);
      // MAVLink v2 trims trailing zero bytes; such a field was not sent.
      const sent = f.offset < plen;
      return { ...F(`p.${f.name}`, f.name + (f.ext ? " (extension)" : ""), from, Math.min(to, p0 + plen), formatValue(f.value), f.meaning || "", f.units || ""),
        trimmed: !sent };
    });
    groups.push({ id: "payload", title: `Payload: ${decoded.name}`, description: decoded.description, trimmed: decoded.trimmed, length: decoded.length, fields });
  } else {
    const why = info.check === "crc" ? "not decoded: the checksum failed, so field values may be corrupt"
      : info.check === "unsupported" ? `not decoded: message id ${msgid} is not in the common dialect`
        : info.check === "reject" ? "not decoded: unsupported incompat flags"
          : "fields are decoded only for HEARTBEAT, SYS_STATUS, GPS_RAW_INT, ATTITUDE, GLOBAL_POSITION_INT and VFR_HUD";
    groups.push({ id: "payload", title: "Payload", fields: plen ? [F("payload", "Payload bytes", p0, p0 + plen, `${plen} bytes`, why)] : [], note: why });
  }

  const crc = crcOf(b, parser, off);
  if (crc) {
    const reading = crc.computed === null ? "computed: not possible (no CRC_EXTRA for this message id)"
      : crc.computed === crc.wire ? "matches" : "does not match";
    groups.push({ id: "crc", title: "Checksum", fields: [
      F("crc", "CRC", crc.at, crc.at + 2, `${hexN(crc.wire, 4)} received${crc.computed === null ? "" : `, ${hexN(crc.computed, 4)} computed`}`, reading),
    ] });
    if (signed && crc.at + 15 <= end) {
      groups.push({ id: "sig", title: "Signature", fields: [
        F("sig", "Signature", crc.at + 2, crc.at + 15, "13 bytes: link id, timestamp, hash", "signature present; not verified"),
      ] });
    }
  }
  return { off, end, start: groups[0].id === "ts" ? off - 8 : off, plen, msgid, signed, crc, groups,
    fields: groups.flatMap((g) => g.fields) };
}
