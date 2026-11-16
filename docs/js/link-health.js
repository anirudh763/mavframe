// Bounded, printable summaries derived only from parser result details already retained in memory.
export function buildLinkHealthTimeline(result, requestedBins = 12) {
  const binsCount = Math.max(1, Math.min(24, Math.floor(requestedBins) || 12, Math.max(1, result.frameCount)));
  const useRecordTime = result.format === 'tlog' && !result.timestampReversals && Number.isFinite(result.firstTs) && Number.isFinite(result.endTs) && result.endTs > result.firstTs;
  const span = useRecordTime ? result.endTs - result.firstTs : Math.max(1, result.frameCount);
  const bins = Array.from({ length: binsCount }, (_, index) => ({
    index, validFrames: 0, crcFailures: 0, unsupportedFrames: 0, sequenceDiscontinuities: 0, timestampReversals: 0, missingEstimate: 0,
    _senders: new Set(), firstFrame: null, lastFrame: null, durationSeconds: useRecordTime ? span / binsCount / 1e6 : null,
    start: useRecordTime ? index * span / binsCount / 1e6 : Math.floor(index * result.frameCount / binsCount) + 1,
    end: useRecordTime ? (index + 1) * span / binsCount / 1e6 : Math.ceil((index + 1) * result.frameCount / binsCount),
  }));
  const bucketForFrame = index => Math.max(0, Math.min(binsCount - 1, Math.floor(index * binsCount / Math.max(1, result.frameCount))));
  const bucketForTime = ts => Math.max(0, Math.min(binsCount - 1, Math.floor((ts - result.firstTs) * binsCount / span)));
  for (let index = 0; index < result.frameCount; index++) {
    const timestamp = result.frames.ts[index];
    const bin = useRecordTime && Number.isFinite(timestamp) ? bins[bucketForTime(timestamp)] : bins[bucketForFrame(index)];
    bin.validFrames++;
    if (bin.firstFrame === null) bin.firstFrame = index;
    bin.lastFrame = index;
    const sysid = result.frames.hdr?.[index * 5 + 1], compid = result.frames.hdr?.[index * 5 + 2];
    if (Number.isInteger(sysid) && Number.isInteger(compid)) bin._senders.add(`${sysid}:${compid}`);
  }
  let retainedCrc = 0, retainedUnsupported = 0, retainedSequence = 0;
  let previousTs = Number.NaN;
  for (let index = 0; index < result.frameCount; index++) {
    const ts = result.frames.ts[index];
    if (!Number.isFinite(ts)) continue;
    if (Number.isFinite(previousTs) && ts < previousTs) {
      const bin = useRecordTime ? bins[bucketForTime(ts)] : bins[bucketForFrame(index)];
      bin.timestampReversals++;
    }
    previousTs = ts;
  }
  for (const issue of result.issues) {
    const sequence = issue.kind === 'gap' || issue.kind === 'duplicate' || issue.kind === 'reorder';
    if (issue.kind !== 'crc' && issue.kind !== 'unsupported' && !sequence) continue;
    const bin = useRecordTime && Number.isFinite(issue.ts) ? bins[bucketForTime(issue.ts)] : bins[bucketForFrame(issue.frame || 0)];
    if (issue.kind === 'crc') { bin.crcFailures++; retainedCrc++; }
    else if (issue.kind === 'unsupported') { bin.unsupportedFrames++; retainedUnsupported++; }
    else { bin.sequenceDiscontinuities++; bin.missingEstimate += issue.kind === 'gap' ? issue.missing || 0 : 0; retainedSequence++; }
  }
  for (const bin of bins) {
    bin.messageRateHz = bin.durationSeconds && bin.durationSeconds > 0 ? bin.validFrames / bin.durationSeconds : null;
    const senders = [...bin._senders].sort(); bin.senderCount = senders.length; bin.sendersOmitted = Math.max(0, senders.length - 8); bin.senders = senders.slice(0, 8); delete bin._senders;
  }
  return {
    axis: useRecordTime ? 'untrusted .tlog record time relative to the first retained frame' : 'frame index (no usable monotonic record timestamps or raw stream)',
    timeBasis: useRecordTime ? 'tlog-record-time' : 'frame-index', bins,
    retained: { crcFailures: retainedCrc, unsupportedFrames: retainedUnsupported, sequenceDiscontinuities: retainedSequence },
    omitted: { crcFailures: Math.max(0, result.crcErrors - retainedCrc), unsupportedFrames: Math.max(0, result.unsupported - retainedUnsupported), sequenceDiscontinuities: Math.max(0, result.gaps + result.duplicates + result.reorders - retainedSequence) },
    timestampReversals: result.timestampReversals || 0,
    assumptions: [
      'Rates count valid parser frames per interval; timestamps are untrusted capture metadata, not receiver arrival measurements.',
      'CRC mismatches identify checksum failures, not authenticated sender identity.',
      'Sequence discontinuities are estimates from recorded sequence numbers, not measured RF loss.',
      'Raw streams have no arrival clock, so rate is unavailable and the table uses frame-index intervals.',
    ],
  };
}

export function linkHealthMarkdown(timeline) {
  const label = n => Number(n).toFixed(2);
  return [
    `Axis: ${timeline.axis}`,
    '',
    '| Interval (frame index) | Valid | CRC | Unsupported | Sequence events | Missing estimate | Timestamp reversals | Sender IDs (up to 8) | Frames/s |',
    '|---|---:|---:|---:|---:|---:|---:|---|---:|',
    ...timeline.bins.map(bin => `| ${timeline.timeBasis === 'tlog-record-time' ? `${label(bin.start)}–${label(bin.end)} s` : `${bin.start}–${bin.end}`} (${bin.firstFrame === null ? 'no frame' : `${bin.firstFrame}–${bin.lastFrame}`}) | ${bin.validFrames} | ${bin.crcFailures} | ${bin.unsupportedFrames} | ${bin.sequenceDiscontinuities} | ${bin.missingEstimate} | ${bin.timestampReversals} | ${bin.senders.join(', ') || 'none'}${bin.sendersOmitted ? `; ${bin.sendersOmitted} omitted` : ''} | ${bin.messageRateHz === null ? 'unavailable' : label(bin.messageRateHz)} |`),
    '',
    `Retained issue details: ${timeline.retained.crcFailures} CRC failures, ${timeline.retained.unsupportedFrames} unsupported messages and ${timeline.retained.sequenceDiscontinuities} sequence discontinuities. Not represented because issue-detail retention limits: ${timeline.omitted.crcFailures} CRC failures, ${timeline.omitted.unsupportedFrames} unsupported messages and ${timeline.omitted.sequenceDiscontinuities} sequence discontinuities. Timestamp reversals in retained frames: ${timeline.timestampReversals}.`,
    ...timeline.assumptions.map(note => `- ${note}`),
  ].join('\n');
}
