// Tests for the WebAssembly build and the inspector's analysis code.
//
//   node --test tests/web/test_wasm.mjs
//
// Needs docs/mavframe.wasm (committed; rebuild with tools/build_wasm.sh), the
// native build/mavframe-dump (cmake) for the native-vs-wasm comparison, and
// python3 with pymavlink for the corrupted comparison stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadParser, analyze, decodePayload, detectFormat, frameAt, STATUS } from "../../docs/js/core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const truth = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/web/sample-truth.json"), "utf8"));
const sample = new Uint8Array(fs.readFileSync(path.join(ROOT, truth.file)));
const parser = await loadParser(fs.readFileSync(path.join(ROOT, "docs/mavframe.wasm")));
const DUMP = process.env.MAVFRAME_DUMP || path.join(ROOT, "build", "mavframe-dump");

function summary(r) {
  return {
    frames: Array.from({ length: r.frameCount }, (_, i) => frameAt(r, i)),
    issues: r.issues.map((i) => ({ ...i, ts: Number.isNaN(i.ts) ? null : i.ts })),
    counts: [r.crcErrors, r.rejects, r.gaps, r.missingFrames, r.skippedBytes, r.timestampArtifacts],
  };
}

function nativeFrames(bytes) {
  assert.ok(fs.existsSync(DUMP), `native parser missing at ${DUMP}: cmake -S . -B build && cmake --build build`);
  const p = spawnSync(DUMP, { input: Buffer.from(bytes), maxBuffer: 1 << 30 });
  assert.equal(p.status, 0, p.stderr.toString());
  const frames = p.stdout.toString().trim().split("\n").filter(Boolean).map((line) => {
    const kv = Object.fromEntries(line.split(" ").map((s) => s.split("=")));
    return [Number(kv.off), Number(kv.msgid), Number(kv.seq), Number(kv.sysid), Number(kv.compid)];
  });
  const counters = Object.fromEntries(p.stderr.toString().trim().split(" ").map((s) => s.split("=").map((v, i) => (i ? Number(v) : v))));
  return { frames, counters };
}

test("sample flight: counts match the generator's ground truth", async () => {
  const r = await analyze(sample, { parser, name: "sample-flight.tlog" });
  assert.equal(r.format, "tlog");
  assert.equal(r.byteLength, truth.bytes);
  assert.equal(r.frameCount, truth.frames);
  assert.equal(r.crcErrors, truth.crc_errors);
  assert.equal(r.gaps, truth.gaps);
  assert.equal(r.missingFrames, truth.missing_frames);
  assert.equal(r.skippedBytes, truth.skipped_bytes);
  assert.equal(r.rejects, 0);
  assert.deepEqual(r.issues.filter((i) => i.kind === "crc").map((i) => i.off), truth.crc_error_offsets);
  assert.deepEqual(
    r.issues.filter((i) => i.kind === "gap").map((g) => ({ offset: g.off, sysid: g.sysid, compid: g.compid, missing: g.missing })),
    truth.gap_list,
  );
  const got = Object.fromEntries(r.messages.map((m) => [String(m.msgid), { name: m.name, count: m.count, crc_errors: m.crcErrors }]));
  assert.deepEqual(got, truth.messages);
  assert.equal(r.firstTs, truth.first_ts_us);
  assert.equal(r.endTs, truth.last_ts_us);
  // pymavlink's own .tlog reader saw the same number of valid frames.
  assert.equal(truth.pymavlink_tlog_reader.valid_v2_frames, r.frameCount);
  const att = r.messages.find((m) => m.name === "ATTITUDE");
  assert.ok(Math.abs(att.rateHz - 10) < 0.05, `ATTITUDE rate ${att.rateHz}`);
});

test("decoded payload fields equal pymavlink's values", async () => {
  const r = await analyze(sample, { parser, name: "sample-flight.tlog" });
  const byOff = new Map(Array.from({ length: r.frameCount }, (_, i) => [r.frames.off[i], frameAt(r, i)]));
  let checked = 0;
  for (const d of truth.decoded) {
    const f = byOff.get(d.offset);
    assert.ok(f, `frame at ${d.offset}`);
    assert.equal(f.msgid, d.msgid);
    const dec = decodePayload(f.msgid, sample.subarray(f.off + 10, f.off + 10 + f.len));
    if (!dec) continue; // SYSTEM_TIME has no decoder in the inspector
    assert.equal(dec.name, d.name);
    const values = Object.fromEntries(dec.fields.map((x) => [x.name, typeof x.value === "bigint" ? String(x.value) : x.value]));
    assert.deepEqual(values, d.fields, `${d.name} at ${d.offset}`);
    checked++;
  }
  assert.equal(checked, 51);
});

test("results do not depend on the chunk size", async () => {
  const ref = summary(await analyze(sample, { parser, name: "x.tlog" }));
  for (const chunkSize of [1, 7, 300, 4096]) {
    const yieldFn = async () => {};
    assert.deepEqual(summary(await analyze(sample, { parser, name: "x.tlog", chunkSize, yieldFn })), ref, `chunk ${chunkSize}`);
  }
});

test("wasm and native builds of the same C source find the same frames", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mavframe-"));
  const corrupt = path.join(tmp, "corrupt.bin");
  const gen = spawnSync("python3", [path.join(ROOT, "bench/gen_stream.py"), "corrupt", "3000", corrupt]);
  assert.equal(gen.status, 0, gen.stderr.toString());
  for (const bytes of [sample, new Uint8Array(fs.readFileSync(corrupt))]) {
    const r = await analyze(bytes, { parser, format: "raw" });
    const wasm = Array.from({ length: r.frameCount }, (_, i) => {
      const f = frameAt(r, i);
      return [f.off, f.msgid, f.seq, f.sysid, f.compid];
    });
    const native = nativeFrames(bytes);
    assert.ok(wasm.length > 1000);
    assert.deepEqual(wasm, native.frames);
    assert.equal(r.stats.bad_crc, native.counters.bad_crc);
    assert.equal(r.stats.unknown_msgid, native.counters.unknown_msgid);
    assert.equal(r.stats.bad_flags, native.counters.bad_flags);
    assert.equal(r.stats.dropped_bytes, native.counters.dropped_bytes);
    assert.equal(r.crcErrors, native.counters.bad_crc); // raw mode: every BAD_CRC event is listed
  }
  fs.rmSync(tmp, { recursive: true });
});

test("a 0xFD inside a .tlog timestamp is not reported as a link error", async () => {
  const first = frameAt(await analyze(sample, { parser, name: "x.tlog" }), 0);
  const frame = sample.subarray(first.off, first.off + first.flen);
  const rec = (tsBytes) => [...tsBytes, ...frame];
  // Byte 6 of the second timestamp is 0xFD: the parser sees a candidate whose
  // incompat flags byte is the real frame's 0xFD start byte (BAD_FLAGS).
  const bytes = new Uint8Array([
    ...rec([0x00, 0x06, 0x47, 0x2b, 0x8a, 0x1c, 0x00, 0x10]),
    ...rec([0x00, 0x06, 0x47, 0x2b, 0x8a, 0x1c, 0xfd, 0x10]),
  ]);
  const t = await analyze(bytes, { parser, format: "tlog" });
  assert.equal(t.frameCount, 2);
  assert.equal(t.stats.bad_flags, 1);
  assert.equal(t.rejects, 0);
  assert.equal(t.timestampArtifacts, 1);
  assert.equal(t.skippedBytes, 0);
  const raw = await analyze(bytes, { parser, format: "raw" });
  assert.equal(raw.rejects, 1);
  assert.equal(raw.issues[0].status, STATUS.BAD_FLAGS);
});

test("random bytes and v1 frames are skipped, not fatal; bytes are accounted for", async () => {
  let s = 12345;
  const junk = new Uint8Array(1 << 20).map(() => ((s = (s * 1103515245 + 12345) >>> 0) >>> 24));
  const v1 = new Uint8Array([0xfe, 9, 0, 2, 191, 0, 0, 0, 0, 0, 18, 8, 0, 4, 3, 0x2c, 0x5e]);
  for (const bytes of [junk, v1, new Uint8Array(0), new Uint8Array([0xfd])]) {
    const r = await analyze(bytes, { parser, format: "raw" });
    let frameBytes = 0;
    for (let i = 0; i < r.frameCount; i++) frameBytes += r.frames.flen[i];
    assert.equal(r.skippedBytes + frameBytes, bytes.length);
  }
  const r = await analyze(v1, { parser, format: "raw" });
  assert.equal(r.frameCount, 0);
  assert.equal(r.skippedBytes, v1.length);
});

test("format detection and zero-trimmed payloads", () => {
  assert.equal(detectFormat(sample, "capture.bin"), "tlog");
  assert.equal(detectFormat(sample.subarray(8), "capture.bin"), "raw");
  assert.equal(detectFormat(new Uint8Array(4), "flight.TLOG"), "tlog");
  // VFR_HUD with every field zero is sent as a 1-byte payload in v2.
  const d = decodePayload(74, new Uint8Array([0]));
  assert.equal(d.trimmed, true);
  assert.ok(d.fields.every((f) => f.value === 0));
  assert.equal(decodePayload(2, new Uint8Array(12)), null);
});

test("hostile input: issue details are capped, counts stay exact", async () => {
  // A fake HEARTBEAT header announcing 255 bytes every 10 bytes: one BAD_CRC per 10 bytes.
  const unit = [0xfd, 0xff, 0, 0, 0, 1, 1, 0, 0, 0];
  const bytes = new Uint8Array(2_000_000).map((_, i) => unit[i % 10]);
  const yieldFn = async () => {};
  const capped = await analyze(bytes, { parser, format: "raw", yieldFn, maxIssues: 1000 });
  assert.equal(capped.crcErrors, capped.stats.bad_crc);
  assert.ok(capped.crcErrors > 150000);
  assert.equal(capped.issues.length, 1000);
  assert.equal(capped.unlistedIssues, capped.crcErrors - 1000);
  const tlog = await analyze(bytes, { parser, format: "tlog", yieldFn, maxIssues: 1000 });
  assert.equal(tlog.issues.length, 1000);
  assert.equal(tlog.crcErrors, tlog.stats.bad_crc);
});
