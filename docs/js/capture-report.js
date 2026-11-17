import { ASSUMPTIONS, MAVFRAME_VERSION, sha256Hex } from './finding.js';
import { buildLinkHealthTimeline, linkHealthMarkdown } from './link-health.js';

const number = value => Number.isFinite(value) ? value : null;
const rate = (count, first, last, reversed) => !reversed && count > 1 && last > first ? (count - 1) * 1e6 / (last - first) : null;

export async function buildCaptureReport({ result: r, bytes, fileName, isSample = false, source = null, customDialectName = null, selection = null, summaryOnly = false }) {
  if (!r || r.bytes !== bytes) throw new Error('The capture changed. Export the current analysis again.');
  if (r._sha256 === undefined) Object.defineProperty(r, '_sha256', { value: await sha256Hex(bytes), enumerable: false });
  const duration = !r.timestampReversals && r.endTs > r.firstTs ? (r.endTs - r.firstTs) / 1e6 : null;
  return {
    schema: 'mavframe-capture/1',
    tool: { name: 'mavframe', version: MAVFRAME_VERSION, parser: 'src/mavframe.c compiled to WebAssembly' },
    source: { name: fileName, bytes: bytes.length, sha256: r._sha256, format: r.format, synthetic: !!isSample, scope: source || 'selected local file' },
    settings: { format: r.format, dialect: customDialectName || 'Pinned common and ArduPilotMega definitions', raw_payloads: 'omitted' },
    clock: { basis: r.format === 'tlog' ? 'untrusted tlog record timestamps' : 'unavailable: raw capture has no arrival clock', first_us: number(r.firstTs), last_us: number(r.endTs), duration_s: duration, reversals: r.timestampReversals || 0 },
    summary: { valid_frames: r.validFrames, crc_failures: r.crcErrors, unsupported: r.unsupported, rejected_flags: r.rejects, sequence_gaps: r.gaps, missing_estimate: r.missingFrames, duplicates: r.duplicates, reorders: r.reorders, skipped_bytes: r.skippedBytes },
    native_counters: { ...r.stats },
    retention: { frame_details: r.frameCount, frame_details_omitted: r.unlistedFrames, issue_details: r.issues.length, issue_details_omitted: r.unlistedIssues, sequence_events_omitted: r.unlistedSequenceEvents, message_sender_groups_truncated: !!r.sourceGroupsTruncated },
    selected_finding: selection && Number.isSafeInteger(selection.row_index) && Number.isSafeInteger(selection.source_offset) ? {
      row_index: selection.row_index, source_offset: selection.source_offset, kind: String(selection.kind || 'frame').slice(0, 32),
      message_id: Number.isSafeInteger(selection.message_id) ? selection.message_id : null,
      system_id: Number.isSafeInteger(selection.system_id) ? selection.system_id : null,
      component_id: Number.isSafeInteger(selection.component_id) ? selection.component_id : null,
      sequence: Number.isSafeInteger(selection.sequence) ? selection.sequence : null,
      field: typeof selection.field === 'string' && selection.field.length <= 128 ? selection.field : null,
    } : null,
    ...(summaryOnly ? {} : {
    messages: r.messages.map(m => ({ id: m.msgid, name: m.name, valid_frames: m.count, crc_failures: m.crcErrors, rate_hz: r.timestampReversals ? null : number(m.rateHz), senders: m.sources.map(s => ({ system: s.sysid, component: s.compid, valid_frames: s.count, rate_hz: r.timestampReversals ? null : number(s.rateHz) })) })),
    senders: r.senders.map(s => ({ system: s.sysid, component: s.compid, valid_frames: s.frames, crc_candidates: s.crcErrors, sequence_gaps: s.gaps, missing_estimate: s.missing, duplicates: s.duplicates, reorders: s.reorders, missing_fraction_estimate: s.frames + s.missing ? s.missing / (s.frames + s.missing) : null, rate_hz: rate(s.frames, s.firstTs, s.lastTs, r.timestampReversals) })),
    sequence_timeline: r.sequenceTimeline.map(i => ({ kind: i.kind, offset: i.off, system: i.sysid, component: i.compid, previous_sequence: i.prevSeq, sequence: i.seq, missing_estimate: i.missing || 0, timestamp_us: number(i.ts), possible_reset: !!i.reset })),
    link_health_timeline: buildLinkHealthTimeline(r),
    }),
    assumptions: [...ASSUMPTIONS, 'Sequence gaps are inferred, not measured RF packet loss; resets, reordering, merged links and recorder loss can produce them.', 'CRC candidate header identities are untrusted when their checksum fails.', 'Rates use record timestamps and are unavailable without a positive interval or when the capture clock reverses. Raw payloads are omitted.'],
  };
}

function cell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string' && (/^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function reportCsv(r) {
  const rows = [
    ['section', 'source', 'system', 'component', 'message_id', 'name', 'valid_frames', 'crc_candidates', 'gaps', 'missing_estimate', 'rate_hz', 'offset', 'timestamp_us', 'unsupported', 'rejected_flags', 'skipped_bytes', 'duplicates', 'reorders'],
    ['summary', r.source.name, '', '', '', '', r.summary.valid_frames, r.summary.crc_failures, r.summary.sequence_gaps, r.summary.missing_estimate, '', '', '', r.summary.unsupported, r.summary.rejected_flags, r.summary.skipped_bytes, r.summary.duplicates, r.summary.reorders],
    ...(r.selected_finding ? [['selected_finding', r.source.name, r.selected_finding.system_id, r.selected_finding.component_id, r.selected_finding.message_id, r.selected_finding.kind, '', '', '', '', '', r.selected_finding.source_offset]] : []),
    ...r.senders.map(s => ['sender', r.source.name, s.system, s.component, '', '', s.valid_frames, s.crc_candidates, s.sequence_gaps, s.missing_estimate, s.rate_hz]),
    ...r.messages.map(m => ['message', r.source.name, '', '', m.id, m.name, m.valid_frames, m.crc_failures, '', '', m.rate_hz]),
    ...r.sequence_timeline.map(i => [i.kind, r.source.name, i.system, i.component, '', '', '', '', '', i.missing_estimate, '', i.offset, i.timestamp_us]),
  ];
  return rows.map(row => Array.from({ length: 18 }, (_, i) => cell(row[i])).join(',')).join('\r\n') + '\r\n';
}

const md = value => String(value ?? 'unavailable').replace(/[\\`|<>\r\n]/g, c => c === '\r' || c === '\n' ? ' ' : '\\' + c);
export function reportMarkdown(r) {
  const selected = r.selected_finding ? `Selected finding: row ${r.selected_finding.row_index}, byte offset ${r.selected_finding.source_offset}, ${md(r.selected_finding.kind)}, message ${r.selected_finding.message_id ?? 'unknown'}, sender ${r.selected_finding.system_id ?? '?'}:${r.selected_finding.component_id ?? '?'}, sequence ${r.selected_finding.sequence ?? '?'}, field ${md(r.selected_finding.field || 'none')}.` : 'Selected finding: none.';
  const lines = ['# MAVLink capture report', '', `Source: ${md(r.source.name)} (${r.source.bytes} bytes)`, `SHA-256: ${md(r.source.sha256)}`, `Provenance: ${md(r.source.scope)}`, `Parser: ${md(r.tool.parser)} · ${md(r.tool.version)}`, `Settings: format ${md(r.settings.format)}; dialect ${md(r.settings.dialect)}; raw payloads ${md(r.settings.raw_payloads)}.`, `Clock: ${md(r.clock.basis)}; duration ${r.clock.duration_s ?? 'unavailable'} s.`, selected, '', `Valid frames: ${r.summary.valid_frames}; CRC failures: ${r.summary.crc_failures}; unsupported IDs: ${r.summary.unsupported}; rejected flags: ${r.summary.rejected_flags}; sequence gaps: ${r.summary.sequence_gaps}; estimated missing: ${r.summary.missing_estimate}; skipped bytes: ${r.summary.skipped_bytes}.`, '', '| System:component | Valid | CRC candidates | Gaps | Missing estimate | Hz |', '|---|---:|---:|---:|---:|---:|', ...r.senders.map(s => `| ${s.system}:${s.component} | ${s.valid_frames} | ${s.crc_candidates} | ${s.sequence_gaps} | ${s.missing_estimate} | ${s.rate_hz?.toFixed(2) ?? 'n/a'} |`), '', '| Message | Valid | CRC failures | Hz |', '|---|---:|---:|---:|', ...r.messages.map(m => `| ${m.id} ${md(m.name)} | ${m.valid_frames} | ${m.crc_failures} | ${m.rate_hz?.toFixed(2) ?? 'n/a'} |`), '', '## Link-health timeline', '', linkHealthMarkdown(r.link_health_timeline), '', '## Sequence timeline', '', '| Kind | Byte offset | Sender | Sequence | Missing estimate |', '|---|---:|---|---:|---:|', ...r.sequence_timeline.map(i => `| ${i.kind} | ${i.offset} | ${i.system}:${i.component} | ${i.sequence} | ${i.missing_estimate} |`), '', `Retained details: ${r.retention.frame_details} frames and ${r.retention.issue_details} findings; omitted: ${r.retention.frame_details_omitted} frames, ${r.retention.issue_details_omitted} findings. Message/sender grouping truncated: ${r.retention.message_sender_groups_truncated}.`, '', ...r.assumptions.map(a => `- ${a}`), ''];
  return lines.join('\n');
}
