// Node tests for the Frames row model (docs/js/rows.js) and the portable
// finding export (docs/js/finding.js), run on the real parser output of the
// bundled engineering fixture.
//
//   node --test tests/web/test_finding.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const truth = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/web/sample-truth.json"), "utf8"));
const SAMPLE = new Uint8Array(fs.readFileSync(path.join(ROOT, truth.file)));
const mod = (rel) => import(path.join(ROOT, "docs/js", rel));

let core;
let parser;
let result;
before(async () => {
  core = await mod("core.js");
  parser = await core.loadParser(fs.readFileSync(path.join(ROOT, "docs/mavframe.wasm")));
  result = await core.analyze(SAMPLE, { parser, name: "sample-flight.tlog" });
});

const hexOf = (b) => Buffer.from(b).toString("hex");

async function rowAt(offset) {
  const { rowIndex, rowInfo } = await mod("rows.js");
  const idx = rowIndex(result);
  for (let k = 0; k < idx.length; k++) {
    const info = rowInfo(result, idx.at(k));
    if (info.off === offset) return { k, ref: idx.at(k), info, idx };
  }
  throw new Error(`no row at offset ${offset}`);
}

test("Frames rows: every valid frame and every CRC-failed / unsupported / bad-flags candidate, in byte order", async () => {
  const { rowIndex, rowInfo } = await mod("rows.js");
  const idx = rowIndex(result);
  assert.equal(idx.length, result.validFrames + result.crcErrors + result.unsupported + result.rejects);
  let prev = -1;
  const crcOffsets = [];
  for (let k = 0; k < idx.length; k++) {
    const info = rowInfo(result, idx.at(k));
    assert.ok(info.off > prev, `row ${k} offset ${info.off} after ${prev}`);
    prev = info.off;
    if (info.check === "crc") crcOffsets.push(info.off);
    assert.equal(idx.positionOf(idx.at(k)), k, "positionOf inverts at");
  }
  assert.deepEqual(crcOffsets, truth.crc_error_offsets);
});

test("ATTITUDE at offset 13866 is a CRC failure: wire 0xA4FE vs computed 0x66D8 from the WebAssembly parser", async () => {
  const { buildFinding } = await mod("finding.js");
  const { ref, info } = await rowAt(13866);
  assert.equal(info.check, "crc");
  assert.equal(info.msgid, 30);
  const f = await buildFinding({ result, bytes: SAMPLE, parser, ref, fileName: "sample-flight.tlog", isSample: true });
  assert.equal(f.finding.kind, "crc_failure");
  assert.equal(f.finding.offset, 13866);
  assert.equal(f.finding.message.name, "ATTITUDE");
  assert.deepEqual(f.finding.crc, { wire: "0xA4FE", computed: "0x66D8", match: false });
  assert.equal(f.file.engineering_fixture, true);
  // ATTITUDE carries no position, so its payload bytes are exported.
  const plen = SAMPLE[13866 + 1];
  assert.equal(f.bytes.payload_hex, hexOf(SAMPLE.subarray(13866 + 10, 13866 + 10 + plen)));
});

test("finding export: version, file hash and assumptions are recorded", async () => {
  const { buildFinding, MAVFRAME_VERSION } = await mod("finding.js");
  const header = fs.readFileSync(path.join(ROOT, "include/mavframe.h"), "utf8");
  assert.equal(MAVFRAME_VERSION, /MAVFRAME_VERSION_STRING "([^"]+)"/.exec(header)[1]);
  const { ref } = await rowAt(13866);
  const f = await buildFinding({ result, bytes: SAMPLE, parser, ref, fileName: "sample-flight.tlog", isSample: true });
  assert.equal(f.tool.version, MAVFRAME_VERSION);
  assert.equal(f.file.size, truth.bytes);
  assert.equal(f.file.sha256, crypto.createHash("sha256").update(SAMPLE).digest("hex"));
  const text = f.assumptions.join(" ");
  assert.match(text, /signature.*not verified/i);
  assert.match(text, /one fully observed channel/i);
  assert.match(text, /not checked/i, "unsupported message ids are not CRC-checked");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(f)), "plain JSON");
});

test("finding export leaves out raw GPS/position payloads by default", async () => {
  const { buildFinding } = await mod("finding.js");
  // The CRC-failed GLOBAL_POSITION_INT candidate and a valid GPS_RAW_INT frame.
  const gpi = await rowAt(34797);
  assert.equal(gpi.info.msgid, 33);
  const { rowInfo } = await mod("rows.js");
  let gps = null;
  for (let k = 0; k < gpi.idx.length && !gps; k++) {
    const info = rowInfo(result, gpi.idx.at(k));
    if (info.msgid === 24 && info.check === "valid") gps = { ref: gpi.idx.at(k), info };
  }
  assert.ok(gps, "sample has a valid GPS_RAW_INT frame");
  for (const { ref, info } of [gpi, gps]) {
    const plen = SAMPLE[info.off + 1];
    const payloadHex = hexOf(SAMPLE.subarray(info.off + 10, info.off + 10 + plen));
    const f = await buildFinding({ result, bytes: SAMPLE, parser, ref, fileName: "x.tlog" });
    const json = JSON.stringify(f);
    assert.equal(f.bytes.payload_hex, undefined, `msgid ${info.msgid}: no payload by default`);
    assert.match(f.bytes.payload_omitted, /position/i);
    assert.ok(!json.includes(payloadHex), `msgid ${info.msgid}: payload bytes absent from the JSON`);
    assert.doesNotMatch(json, /"(lat|lon|alt)"/, "no decoded position fields");
    // Opting in is the only way to get them.
    const g = await buildFinding({ result, bytes: SAMPLE, parser, ref, fileName: "x.tlog", includeAllPayloads: true });
    assert.equal(g.bytes.payload_hex, payloadHex);
  }
});

test("a valid frame's finding shows matching CRCs and its sequence note", async () => {
  const { buildFinding } = await mod("finding.js");
  const { rowIndex, rowInfo } = await mod("rows.js");
  const idx = rowIndex(result);
  const gapFrame = truth.gap_list[0];
  let hit = null;
  for (let k = 0; k < idx.length && !hit; k++) {
    const info = rowInfo(result, idx.at(k));
    if (info.seqIssue && info.seqIssue.kind === "gap") hit = { ref: idx.at(k), info };
  }
  assert.ok(hit && gapFrame, "sample has a gap");
  const f = await buildFinding({ result, bytes: SAMPLE, parser, ref: hit.ref, fileName: "x.tlog" });
  assert.equal(f.finding.kind, "valid_frame");
  assert.equal(f.finding.crc.match, true);
  assert.equal(f.finding.sequence.kind, "gap");
  assert.ok(f.finding.sequence.missing_estimate >= 1);
});
