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

import { loadParser, analyze, decodePayload, detectFormat, frameAt, rawEvents, STATUS, MAX_CAPTURE_BYTES } from "../../docs/js/core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const truth = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/web/sample-truth.json"), "utf8"));
const sample = new Uint8Array(fs.readFileSync(path.join(ROOT, truth.file)));
const parser = await loadParser(fs.readFileSync(path.join(ROOT, "docs/mavframe.wasm")));
const DUMP = process.env.MAVFRAME_DUMP || path.join(ROOT, "build", "mavframe-dump");
const GLUE = process.env.MAVFRAME_GLUE_DUMP || path.join(ROOT, "build", "glue_dump");
const CASES = fs.mkdtempSync(path.join(os.tmpdir(), "mavframe-cases-"));
{
  const gen = spawnSync("python3", [path.join(ROOT, "tests/web/gen_cases.py"), CASES]);
  assert.equal(gen.status, 0, gen.stderr.toString());
}
const readCase = (name) => new Uint8Array(fs.readFileSync(path.join(CASES, name)));

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
  assert.equal(r.unsupported, 0);
  assert.equal(r.validFrames, truth.frames);
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
    assert.equal(r.crcErrors + r.nestedCrc, native.counters.bad_crc); // every BAD_CRC event: listed, or nested in a failed frame
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
  assert.equal(capped.crcErrors + capped.nestedCrc, capped.stats.bad_crc);
  assert.ok(capped.stats.bad_crc > 150000);
  assert.ok(capped.crcErrors > 1000); // most fake headers sit inside an earlier failed one (nestedCrc)
  assert.equal(capped.issues.length, 1000);
  assert.equal(capped.unlistedIssues, capped.crcErrors - 1000);
  const tlog = await analyze(bytes, { parser, format: "tlog", yieldFn, maxIssues: 1000 });
  assert.equal(tlog.issues.length, 1000);
  assert.equal(tlog.crcErrors + tlog.nestedCrc, tlog.stats.bad_crc);
});

// ---------- the WebAssembly module is the same C code as the native build ----------

// Native build of the same glue + parser sources (build/glue_dump).
function nativeEvents(bytes, args) {
  assert.ok(fs.existsSync(GLUE), `native glue build missing at ${GLUE}: cmake --build build`);
  const p = spawnSync(GLUE, args, { input: Buffer.from(bytes), maxBuffer: 1 << 28 });
  assert.equal(p.status, 0, p.stderr.toString());
  const lines = p.stdout.toString().trim().split("\n");
  const st = lines.pop().split(" ").slice(1).map(Number);
  return {
    events: lines.filter(Boolean).map((l) => l.split(" ").map(Number)),
    stats: { bytes: st[0], frames: st[1], bad_crc: st[2], unknown_msgid: st[3], bad_flags: st[4], dropped_bytes: st[5] },
  };
}

function chunks(len, size) {
  const r = [];
  for (let p = 0; p < len; p += size) r.push(Math.min(size, len - p));
  return r;
}

// Script under test; WASM_BUILD_SCRIPT lets the sabotage check point it at a modified copy.
const BUILD_SCRIPT = process.env.WASM_BUILD_SCRIPT || path.join(ROOT, "tools/build_wasm.sh");
const EXPECTED_SOURCES = ["src/mavframe.c", "web/wasm/mavframe_wasm.c"];

test("the wasm module is compiled from src/mavframe.c itself (no copy) and is up to date", () => {
  const files = spawnSync("git", ["ls-files", "*.c", "*.h"], { cwd: ROOT }).stdout.toString().trim().split("\n");
  assert.deepEqual(files.filter((f) => path.basename(f) === "mavframe.c"), ["src/mavframe.c"]);
  const zig = spawnSync("python3", ["-c", "import ziglang"]);
  if (zig.status !== 0) {
    console.log("# ziglang not installed: compiler command not checked here (CI runs it)");
    return;
  }
  // Run the real build with sh -x and read the C files from the compiler
  // command that actually ran, not from the script text.
  const out = path.join(CASES, "rebuilt.wasm");
  const b = spawnSync("sh", ["-x", BUILD_SCRIPT, out], { cwd: ROOT });
  assert.equal(b.status, 0, b.stderr.toString());
  const cc = b.stderr.toString().split("\n").filter((l) => /^\++ python3 -m ziglang cc /.test(l));
  assert.equal(cc.length, 1, "exactly one compiler command");
  const compiled = cc[0].split(/\s+/).filter((a) => /\.c$/.test(a));
  assert.deepEqual(compiled, EXPECTED_SOURCES, "C files given to the compiler");
  assert.match(b.stdout.toString(), new RegExp(`^sources: ${EXPECTED_SOURCES.join(" ")}$`, "m"));
  assert.ok(fs.readFileSync(out).equals(fs.readFileSync(path.join(ROOT, "docs/mavframe.wasm"))),
    "docs/mavframe.wasm differs from a fresh build of src/mavframe.c");
});

test("analyze() refuses captures over the size limit and accepts one exactly at it", async () => {
  // Sized stand-ins instead of real 256 MB buffers: only length and subarray are used.
  const zeros = new Uint8Array(parser.inputCap);
  const sized = (length) => ({ length, subarray: (a, b) => zeros.subarray(0, b - a) });
  await assert.rejects(analyze(sized(MAX_CAPTURE_BYTES + 1), { parser, format: "raw" }),
    { message: `capture larger than ${MAX_CAPTURE_BYTES / 1048576} MB` });
  const r = await analyze(sized(MAX_CAPTURE_BYTES), { parser, format: "raw", chunkSize: parser.inputCap, yieldFn: async () => {} });
  assert.equal(r.byteLength, MAX_CAPTURE_BYTES);
  assert.equal(r.stats.bytes, MAX_CAPTURE_BYTES);
  assert.equal(r.skippedBytes, MAX_CAPTURE_BYTES);
});

test("native and wasm builds give identical events: malformed, signed and chunked input", () => {
  const corruptPath = path.join(CASES, "corrupt.bin");
  assert.equal(spawnSync("python3", [path.join(ROOT, "bench/gen_stream.py"), "corrupt", "3000", corruptPath]).status, 0);
  const streams = {
    sample, corrupt: new Uint8Array(fs.readFileSync(corruptPath)),
    signed: readCase("signed.bin"), malformed: readCase("malformed.bin"), boundary: readCase("boundary.bin"),
  };
  let compared = 0;
  for (const [name, bytes] of Object.entries(streams)) {
    // Read sizes tested: 1, 2, 3, 7, 10, 13, 255, 4096 bytes and the whole stream in one read.
    for (const size of [bytes.length, 1, 2, 3, 7, 10, 13, 255, 4096]) {
      const w = rawEvents(parser, bytes, chunks(bytes.length, size));
      const n = nativeEvents(bytes, [`c${size}`]);
      assert.deepEqual(w, n, `${name}, reads of ${size} bytes`);
      compared += w.events.length;
    }
  }
  console.log(`# native vs wasm: ${compared} events compared`);
  // Each case really occurs.
  const ev = rawEvents(parser, streams.malformed, [streams.malformed.length]).events;
  for (const st of [STATUS.FRAME, STATUS.BAD_CRC, STATUS.UNKNOWN_MSGID, STATUS.BAD_FLAGS]) {
    assert.ok(ev.some((e) => e[2] === st), `status ${st} in malformed.bin`);
  }
  const signedFrames = rawEvents(parser, streams.signed, [streams.signed.length]).events.filter((e) => e[2] === STATUS.FRAME);
  assert.ok(signedFrames.length >= 20 && signedFrames.every((e) => e[7] & 1), "signed frames reported with the signed flag");
});

test("native and wasm agree when the stream is split into two reads at every byte boundary", () => {
  for (const name of ["boundary.bin", "malformed.bin"]) {
    const bytes = readCase(name);
    const ref = rawEvents(parser, bytes, [bytes.length]);
    assert.deepEqual(nativeEvents(bytes, []), ref, `${name} whole`);
    for (let k = 1; k < bytes.length; k++) {
      const reads = [k, bytes.length - k];
      const w = rawEvents(parser, bytes, reads);
      assert.deepEqual(w, ref, `${name}: wasm, split at ${k}`);
      assert.deepEqual(nativeEvents(bytes, [String(k)]), ref, `${name}: native, split at ${k}`);
    }
    console.log(`# ${name}: ${bytes.length - 1} split points, ${ref.events.length} events each`);
  }
});

test("unknown message ids are counted as unsupported, not as corrupt", async () => {
  const r = await analyze(readCase("malformed.bin"), { parser, format: "raw" });
  assert.ok(r.unsupported >= 1);
  assert.ok(r.crcErrors >= 1);
  assert.ok(r.rejects >= 1);
  assert.equal(r.unsupported, r.stats.unknown_msgid);
  assert.equal(r.crcErrors, r.stats.bad_crc);
  assert.equal(r.rejects, r.stats.bad_flags);
  assert.ok(r.issues.filter((i) => i.kind === "unsupported").every((i) => i.status === STATUS.UNKNOWN_MSGID));
});

test("analysis can be cancelled between chunks and frame details are capped", async () => {
  const ctl = new AbortController();
  let chunksSeen = 0;
  await assert.rejects(
    analyze(sample, { parser, name: "x.tlog", chunkSize: 1000, yieldFn: async () => {}, signal: ctl.signal,
      onProgress: () => { if (++chunksSeen === 3) ctl.abort(); } }),
    { name: "AbortError" });
  assert.equal(chunksSeen, 3);
  const capped = await analyze(sample, { parser, name: "x.tlog", maxFrames: 100 });
  assert.equal(capped.frameCount, 100);
  assert.equal(capped.validFrames, truth.frames);
  assert.equal(capped.crcErrors, truth.crc_errors);
  assert.equal(capped.gaps, truth.gaps);
  assert.equal(capped.endTs, truth.last_ts_us);
});

// ---------- sequence numbers: gaps, duplicates, out-of-order, wraparound ----------
const SEQ_EXPECT = {
  // name: [seqs, gaps, ~missing, duplicates, reorders]
  "in-order": [[10, 11], 0, 0, 0, 0],
  duplicate: [[10, 10, 11], 0, 0, 1, 0],
  backwards: [[10, 9, 11], 0, 0, 0, 1],
  wrap: [[255, 0], 0, 0, 0, 0],
  gap: [[10, 13], 1, 2, 0, 0],
  reset: [[200, 150, 151], 0, 0, 0, 1],
};

test("sequence numbers: duplicates and backward steps are not gaps; 255 -> 0 is in order", async () => {
  for (const [name, [seqs, gaps, missing, dups, reorders]] of Object.entries(SEQ_EXPECT)) {
    const bytes = readCase(`seq-${name}.bin`);
    // Wasm and native builds see the same frames with these sequence numbers.
    const w = rawEvents(parser, bytes, [bytes.length]);
    assert.deepEqual(w, nativeEvents(bytes, []), `${name}: native vs wasm`);
    assert.deepEqual(w.events.map((e) => e[3]), seqs, `${name}: seq values`);
    assert.ok(w.events.every((e) => e[2] === STATUS.FRAME), `${name}: all frames valid`);
    const r = await analyze(bytes, { parser, format: "raw" });
    assert.deepEqual([r.gaps, r.missingFrames, r.duplicates, r.reorders, r.crcErrors],
      [gaps, missing, dups, reorders, 0], `${name}: [gaps, ~missing, duplicates, reorders, crc]`);
  }
  const reset = await analyze(readCase("seq-reset.bin"), { parser, format: "raw" });
  assert.equal(reset.issues[0].reset, true);
  const late = await analyze(readCase("seq-backwards.bin"), { parser, format: "raw" });
  assert.deepEqual([late.issues[0].kind, late.issues[0].back, late.issues[0].reset], ["reorder", 1, false]);
});

test("corrupted .tlog frames give CRC errors only: no false rejects from timestamp or frame bytes", async () => {
  const expect = JSON.parse(fs.readFileSync(path.join(CASES, "corrupt-ts.json"), "utf8"));
  const r = await analyze(readCase("corrupt-ts.tlog"), { parser, format: "tlog" });
  assert.equal(r.validFrames, expect.frames);
  assert.equal(r.crcErrors, expect.crc_errors);
  assert.equal(r.rejects, 0, "bad-flags issues");
  assert.equal(r.unsupported, 0, "unsupported issues");
  assert.equal(r.issues.filter((i) => i.kind !== "crc" && i.kind !== "gap").length, 0);
  // The parser did see these candidates; all are accounted for as timestamp bytes or damaged-frame bytes.
  assert.ok(r.stats.bad_flags + r.stats.unknown_msgid > 1000);
  assert.equal(r.crcErrors + r.unsupported + r.rejects + r.timestampArtifacts + r.insideFailedFrame,
    r.stats.bad_crc + r.stats.unknown_msgid + r.stats.bad_flags);
  assert.equal(r.stats.bad_crc, expect.crc_errors);
});

test("critic's .tlog (20,000 frames, 3 senders, seed 9001): nested fake frames add no CRC errors or rejects", async () => {
  // Generated by tests/web/gen_critic_tlog.py (seed 9001); 200 frames corrupted,
  // 0xFD forced into ~15% of timestamps. Rescanning one corrupted
  // ENCAPSULATED_DATA frame finds a fake HEARTBEAT header whose CRC also fails.
  const expect = JSON.parse(fs.readFileSync(path.join(CASES, "critic-9001.json"), "utf8"));
  const r = await analyze(readCase("critic-9001.tlog"), { parser, format: "tlog" });
  assert.equal(r.validFrames, expect.frames);
  assert.equal(r.crcErrors, expect.crc);
  assert.equal(r.unsupported, 0);
  assert.equal(r.rejects, 0);
  assert.equal(r.gaps, expect.gaps_expected);
  assert.ok(r.nestedCrc >= 1, "the fixture contains the nested-CRC case");
  // Every rejection event of the parser is accounted for exactly once.
  assert.equal(r.crcErrors + r.unsupported + r.rejects + r.timestampArtifacts + r.insideFailedFrame,
    r.stats.bad_crc + r.stats.unknown_msgid + r.stats.bad_flags);
});
