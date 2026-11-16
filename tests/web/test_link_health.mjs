import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLinkHealthTimeline, linkHealthMarkdown } from '../../docs/js/link-health.js';

function result(overrides = {}) {
  const n = overrides.frameCount ?? 4;
  return {
    format: 'raw', frameCount: n, firstTs: 0, endTs: 0, timestampReversals: 0,
    frames: { ts: new Float64Array(n).fill(Number.NaN) },
    issues: [], crcErrors: 0, unsupported: 0, gaps: 0, duplicates: 0, reorders: 0,
    ...overrides,
  };
}

test('raw link health uses frame index, has no invented clock, and includes sequence estimates', () => {
  const timeline = buildLinkHealthTimeline(result({
    frames: { ts: new Float64Array(4).fill(Number.NaN), hdr: Uint8Array.of(1, 9, 2, 0, 0, 2, 9, 2, 0, 0, 3, 8, 7, 0, 0, 4, 8, 7, 0, 0) },
    issues: [{ kind: 'crc', frame: 1 }, { kind: 'unsupported', frame: 1 }, { kind: 'gap', frame: 2, missing: 3 }, { kind: 'duplicate', frame: 3 }],
    crcErrors: 2, unsupported: 1, gaps: 2, duplicates: 1,
  }), 2);
  assert.equal(timeline.timeBasis, 'frame-index');
  assert.equal(timeline.bins.length, 2);
  assert.deepEqual(timeline.bins.map(bin => bin.validFrames), [2, 2]);
  assert.deepEqual(timeline.bins.map(bin => bin.messageRateHz), [null, null]);
  assert.equal(timeline.bins[1].missingEstimate, 3);
  assert.equal(timeline.bins[0].unsupportedFrames, 1);
  assert.deepEqual(timeline.bins[0].senders, ['9:2']);
  assert.deepEqual(timeline.omitted, { crcFailures: 1, unsupportedFrames: 0, sequenceDiscontinuities: 1 });
  assert.match(linkHealthMarkdown(timeline), /not measured RF loss/i);
});

test('monotonic tlog timestamps produce interval rates and timestamped events', () => {
  const timeline = buildLinkHealthTimeline(result({
    format: 'tlog', frameCount: 4, firstTs: 1_000_000, endTs: 5_000_000,
    frames: { ts: Float64Array.of(1_000_000, 2_000_000, 4_000_000, 5_000_000), hdr: new Uint8Array(20) },
    issues: [{ kind: 'crc', ts: 4_500_000, frame: 3 }], crcErrors: 1,
  }), 2);
  assert.equal(timeline.timeBasis, 'tlog-record-time');
  assert.deepEqual(timeline.bins.map(bin => bin.validFrames), [2, 2]);
  assert.deepEqual(timeline.bins.map(bin => bin.messageRateHz), [1, 1]);
  assert.deepEqual(timeline.bins.map(bin => bin.crcFailures), [0, 1]);
  assert.match(timeline.axis, /untrusted/);
});

test('bad or reversed clocks, zero frames, and huge bin requests stay bounded', () => {
  const noFrames = buildLinkHealthTimeline(result({ frameCount: 0, frames: { ts: new Float64Array() } }), 999);
  assert.equal(noFrames.bins.length, 1);
  assert.ok(noFrames.bins.every(bin => Number.isFinite(bin.start) && Number.isFinite(bin.end)));
  const reversed = buildLinkHealthTimeline(result({ format: 'tlog', firstTs: 8, endTs: 2, timestampReversals: 1 }));
  assert.equal(reversed.timeBasis, 'frame-index');
  assert.ok(reversed.bins.every(bin => bin.messageRateHz === null));
});
