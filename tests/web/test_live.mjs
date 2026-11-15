import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadParser } from '../../docs/js/core.js';
import { liveAnalyzer, LIVE_RETAIN_BYTES } from '../../docs/js/live-core.js';
const wasm = await readFile(new URL('../../docs/mavframe.wasm', import.meta.url));
const sample = new Uint8Array(await readFile(new URL('../../docs/sample/sample-flight.tlog', import.meta.url)));
const frame = sample.slice(8, 29);

test('persistent native parser keeps a frame across one-byte serial reads', async () => {
  const live = liveAnalyzer(await loadParser(wasm));
  for (let i = 0; i < frame.length; i++) live.feed(frame.slice(i, i + 1), i);
  assert.equal(live.summary().stats.frames, 1);
  assert.equal(live.summary().stats.bad_crc, 0);
  assert.deepEqual(live.snapshot().bytes, frame);
  assert.equal(live.summary().clock.includes('arrival'), true);
});

test('retained serial bytes are bounded, exact and explicitly report discarded history', async () => {
  const live = liveAnalyzer(await loadParser(wasm));
  const chunk = new Uint8Array(65536);
  for (let i = 0; i < LIVE_RETAIN_BYTES / chunk.length + 1; i++) { chunk.fill(i); live.feed(chunk, i); }
  assert.throws(() => live.feed(new Uint8Array(65537), 200), /64 KiB/);
  assert.throws(() => live.feed(new Uint8Array(1), 1), /monotonic/);
  const snapshot = live.snapshot();
  assert.equal(snapshot.bytes.length, LIVE_RETAIN_BYTES);
  assert.equal(snapshot.discarded, chunk.length);
  assert.equal(snapshot.bytes[0], 1);
  assert.equal(snapshot.bytes.at(-1), 128);
  assert.throws(() => live.feed(new Uint8Array(1), 201), /ended/);
});

test('a contiguous unknown-dialect header does not invent live packet loss', async () => {
  const parser = await loadParser(wasm);
  const known = seq => {
    const bytes = frame.slice(); bytes[4] = seq;
    const crc = parser.crc(bytes); bytes[bytes.length - 2] = crc & 255; bytes[bytes.length - 1] = crc >> 8;
    return bytes;
  };
  const first = known(1), last = known(3);
  const custom = Uint8Array.of(0xfd, 0, 0, 0, 2, first[5], first[6], 3, 0, 0, 0, 0);
  const bytes = Uint8Array.from([...first, ...custom, ...last]);
  const live = liveAnalyzer(parser);
  live.feed(bytes, 1);
  const result = live.summary();
  assert.equal(result.stats.frames, 2);
  assert.equal(result.stats.unknown_msgid, 1);
  assert.equal(result.gaps, 0);
  assert.equal(result.missing_estimate, 0);
});
