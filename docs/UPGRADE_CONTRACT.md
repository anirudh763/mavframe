# MAVLink workbench upgrade

Owner request, 2026-11-14: improve the current engineering tool in the existing repository. Keep the MIT C99 parser, native CLI, same C compiled to Wasm, current public paths and distinct light interface. External competitor notes are requests to investigate, not verified superiority or licensing claims.

## Protocol and definitions

Add mixed MAVLink v1/v2 parsing to the actual native C state machine. Preserve bounded zero-allocation behavior, public source compatibility where possible, v2 signing/unsupported-flag diagnostics and CRC_EXTRA validation. V1 uses its actual header/CRC rules, not a JavaScript parser or conversion pretending to be v2. Signed v2 packets are not authenticated without a real signing-key verifier.

Generate CRC and field definitions from checksum-pinned official common.xml plus ardupilotmega.xml and their includes. Preserve exact source revision, hashes, generator version and upstream notices; cross-check field order, arrays, extensions, lengths and CRC_EXTRA against the matching pymavlink dialect. Retain offline reproducibility of committed generated data. Unknown/custom dialect messages remain explicitly unknown rather than being labeled CRC corruption. Decode all supported standard fields; missing v2 extension bytes follow documented zero-fill semantics and are distinguished from captured bytes. No JavaScript replacement of native framing/checksum decisions.

Fix the theme action label and accessible current-state indication. Use concise icon navigation and semantic diagnostics, aligned tabular hex/offsets, keyboard focus and 44px primary controls. Byte editing/flipping and the seeded 1,000-iteration fuzz tool must feed the exact compiled C parser, show actual results/timings, bound work and support cancellation. Preserve originals.

## Capture reports and samples

Export full-capture JSON, CSV and Markdown: source type/size/digest where available, boundedness/truncation, native valid/CRC/unknown/skipped counts, per-sender/message rate, sequence-gap/reorder timeline, clock basis and analysis version. Loss is inferred from sequence gaps, not proven RF packet loss; sender resets, reordering, capture loss and mixed streams affect it. Show unavailable rates when no trustworthy elapsed interval exists. Never include raw private payloads without a clear explicit export choice, and protect CSV cells from spreadsheet formula execution.

Retain the clearly synthetic engineering fixture. Add one real-world capture only with verified source, checksum, provenance and redistribution permission/notice; distinguish real hardware, SITL and re-encoded telemetry. Never rename synthetic data as real RF interference. If no licensed physical capture can be verified, retain that gap explicitly and provide the usable private local-file workflow.

## Live serial

Add a real user-gesture WebSerial connection to a user-selected radio. Unsupported browsers display a useful reason; never bypass the browser chooser. Read bounded chunks into a persistent C/Wasm parser state across chunk boundaries, track arrival-clock provenance, throttle rendering and cap retained raw/frame history. Report dropped history and disable unavailable old byte details; aggregate counters must remain truthful. Disconnect/cancel releases reader, port and worker with actionable errors; no fake telemetry playback presented as live. A local WebSocket bridge is optional, not required for this vertical slice. Physical-radio verification requires actual hardware; platform test doubles may test browser API behavior but cannot be reported as a hardware test.

## Gates

Preserve existing native/Python/Wasm/browser cases, update only deliberately changed version/dialect expectations, and add v1/v2/mixed, truncated/invalid CRC, sequence reorder/gaps, hostile lengths, zero/noise and real-native fuzz cases. Run ASan/UBSan, finite native-vs-Wasm differential corpus, generator parity and capture-export integrity. Verify 320/768/1440, keyboard/focus, axe, empty/loading/error/cancel states, offline behavior and zero observed unexpected console/CSP errors in named runs. Test live chunk boundaries, retention and cleanup through the real parser. State hardware/format/finite-corpus limits. Two independent critics and green current-head CI precede release; no new repository, paid hosting or commercial-license claim over existing MIT rights.
