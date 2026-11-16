#!/usr/bin/env node
// Reproducibly scrub the permitted DroneKit-LA public ArduPilot telemetry log.
// Usage: node tools/derive_public_sample.mjs /path/to/original/flight.tlog [output]
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadParser, analyze, frameAt } from '../docs/js/core.js';
import { MESSAGES } from '../docs/js/msgdefs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
const output = process.argv[3] || path.join(root, 'docs/sample/real-flight-redacted.tlog');
const SOURCE_SHA256 = '16c79fedb900a61e9f67bca6133dd49a40a66f6b431e75138c8d9023c9a31523';
if (!input) throw new Error('Provide the original DroneKit-LA flight.tlog path.');
const source = new Uint8Array(fs.readFileSync(input));
const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
if (sourceHash !== SOURCE_SHA256) throw new Error(`Unexpected source SHA-256: ${sourceHash}`);
const parser = await loadParser(fs.readFileSync(path.join(root, 'docs/mavframe.wasm')));
const parsed = await analyze(source, { parser, name: 'flight.tlog', format: 'tlog' });
if (parsed.frameCount !== 163851 || parsed.crcErrors !== 0 || parsed.rejects !== 0) {
  throw new Error('Source parser counters do not match the documented source revision.');
}
const bytes = Buffer.from(source);
let scrubbed = 0;
for (let i = 0; i < parsed.frameCount; i++) {
  const frame = frameAt(parsed, i);
  if (frame.msgid !== 24 && frame.msgid !== 33) continue;
  const start = frame.off;
  if (bytes[start] !== 0xfe) throw new Error(`Unexpected frame version at ${start}.`);
  const header = 6;
  const payload = start + header;
  const layout = MESSAGES[String(frame.msgid)];
  const latField = layout.fields.find(field => field.name === 'lat');
  const lonField = layout.fields.find(field => field.name === 'lon');
  for (const field of [latField, lonField]) bytes.fill(0, payload + field.offset, payload + field.offset + 4);

  // MAVLink v1 X.25 checksum over header (excluding magic), payload and CRC_EXTRA.
  let crc = 0xffff;
  const accumulate = value => {
    let tmp = value ^ (crc & 0xff);
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  };
  const payloadLength = bytes[start + 1];
  for (let at = start + 1; at < payload + payloadLength; at++) accumulate(bytes[at]);
  accumulate(layout.crc_extra);
  const checksumAt = payload + payloadLength;
  bytes[checksumAt] = crc & 0xff;
  bytes[checksumAt + 1] = crc >> 8;
  scrubbed++;
}
if (scrubbed !== 12642) throw new Error(`Expected 12,642 position messages; scrubbed ${scrubbed}.`);
const result = await analyze(bytes, { parser, name: 'real-flight-redacted.tlog', format: 'tlog' });
if (result.frameCount !== parsed.frameCount || result.validFrames !== parsed.validFrames || result.crcErrors !== 0 || result.rejects !== 0) {
  throw new Error('Redacted output changed parser validity or frame counters.');
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, bytes, { mode: 0o644 });
console.log(JSON.stringify({ sourceSha256: sourceHash, output, bytes: bytes.length, redactedPositionMessages: scrubbed,
  validFrames: result.validFrames, crcErrors: result.crcErrors, rejects: result.rejects,
  estimatedGaps: result.gaps, estimatedMissingFrames: result.missingFrames, skippedBytes: result.skippedBytes,
  timestampArtifacts: result.timestampArtifacts, outputSha256: crypto.createHash('sha256').update(bytes).digest('hex') }, null, 2));
