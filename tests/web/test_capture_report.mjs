import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadParser, analyze } from '../../docs/js/core.js';

const parser = await loadParser(await readFile(new URL('../../docs/mavframe.wasm', import.meta.url)));
const sample = new Uint8Array(await readFile(new URL('../../docs/sample/sample-flight.tlog', import.meta.url)));

test('capture exports cover the full analysis, even when retained frame details are capped', async () => {
  const { buildCaptureReport, reportCsv, reportMarkdown } = await import('../../docs/js/capture-report.js');
  const result = await analyze(sample, { parser, name: 'sample-flight.tlog', maxFrames: 2 });
  const report = await buildCaptureReport({ result, bytes: sample, fileName: '=private.tlog', isSample: true });
  assert.equal(report.summary.valid_frames, 1497);
  assert.equal(report.summary.crc_failures, 3);
  assert.equal(report.summary.sequence_gaps, 4);
  assert.equal(report.retention.frame_details, 2);
  assert.equal(report.retention.frame_details_omitted, 1495);
  assert.equal(report.senders.reduce((n, s) => n + s.valid_frames, 0), 1497);
  assert.equal(report.messages.reduce((n, m) => n + m.valid_frames, 0), 1497);
  assert.match(report.source.sha256, /^[a-f0-9]{64}$/);
  assert.match(report.clock.basis, /tlog/);
  assert.match(report.assumptions.join(' '), /not.*RF|not.*radio/);
  assert.equal(JSON.stringify(report).includes('payload_hex'), false);
  assert.ok(report.sequence_timeline.some(i => i.kind === 'gap'));
  assert.match(reportCsv(report), /'\=private\.tlog/);
  assert.match(reportMarkdown(report), /1497/);
});

test('raw captures never invent Hz or a capture clock', async () => {
  const { buildCaptureReport } = await import('../../docs/js/capture-report.js');
  const raw = sample.slice(8, 8 + 21);
  const result = await analyze(raw, { parser, format: 'raw' });
  const report = await buildCaptureReport({ result, bytes: raw, fileName: 'one-frame.raw' });
  assert.equal(report.clock.duration_s, null);
  assert.equal(report.messages[0].rate_hz, null);
});


test('bounded saved summary uses the same engine counts, settings and source hash without materializing timelines', async () => {
  const { buildCaptureReport } = await import('../../docs/js/capture-report.js');
  const bytes = sample;
  const result = await analyze(bytes, { parser, format: 'tlog' });
  const full = await buildCaptureReport({ result, bytes, fileName: 'sample.tlog' });
  const bounded = await buildCaptureReport({ result, bytes, fileName: 'sample.tlog', summaryOnly: true });
  for (const field of ['summary', 'settings', 'source', 'retention']) assert.deepEqual(bounded[field], full[field]);
  assert.equal(bounded.sequence_timeline, undefined);
  assert.equal(bounded.link_health_timeline, undefined);
  assert.ok(new TextEncoder().encode(JSON.stringify(bounded)).length < 65536);
});
