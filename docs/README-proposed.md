# Proposed README text (for the conductor to merge)

Suggested placement: a new section after "Quick start", plus one line in
"Limitations" and one line in the "Tests" and "Fuzzing" sections. The existing
"How this was built" disclosure stays as it is.

---

## Browser inspector

**Live page:** https://anirudh763.github.io/mavframe/ (served from `docs/` once GitHub Pages is enabled for `main` / `docs`).

![mavframe inspector showing the synthetic sample flight with a CRC error selected](docs/screenshots/inspector.png)

The same C parser (`src/mavframe.c`, unchanged) is compiled to a 4,086-byte
WebAssembly module and runs in the browser. Open a `.tlog` (8-byte big-endian
microsecond timestamp before each frame) or a raw byte stream, or press
**Load sample flight**. The page shows:

- a message table: id, name, sending system:component, count, rate in Hz (from
  .tlog timestamps) and CRC errors per message;
- a timeline of frames per interval with CRC errors and sequence-number gaps
  marked (Previous issue / Next issue step through them by keyboard);
- a frame list and an issue list, filterable by message, with the view kept in
  the URL for the built-in sample;
- the selected frame's bytes (timestamp, header, payload, CRC, signature) and its
  decoded header; payload fields are decoded for HEARTBEAT, SYS_STATUS,
  GPS_RAW_INT, ATTITUDE, GLOBAL_POSITION_INT and VFR_HUD. For a CRC error it
  shows the received checksum and the one `mavframe_crc16()` computes.

Files are read in the tab and never uploaded. MAVLink v1 frames and garbage are
counted as skipped bytes. In .tlog mode, a 0xFD byte inside a timestamp that the
parser briefly takes for a frame start is counted separately and not reported as
a link error (20 such bytes in the sample).

The sample is synthetic and labelled so in the page: 60 seconds of made-up
telemetry from a simulated quadrotor, packed by pymavlink 2.4.50
(`tools/gen_sample_tlog.py`), with three frames altered after packing (CRC
errors), one frame never written (a sequence gap) and one MAVLink v1 record.

How it is built and checked:

```sh
pip install ziglang==0.17.1
sh tools/build_wasm.sh                            # docs/mavframe.wasm, byte-for-byte reproducible
python3 tools/gen_web_defs.py > docs/js/msgdefs.js # payload layouts from the official MAVLink XML
python3 tools/gen_sample_tlog.py                   # sample capture + tests/web/sample-truth.json
node --test tests/web/test_wasm.mjs                # 8 tests
node --test tests/web/test_ui.mjs                  # 6 tests (Playwright + axe-core)
```

- Payload layouts come from an excerpt of the official definitions
  (`common.xml`, `standard.xml`, `minimal.xml` at mavlink/mavlink commit
  `12c898d`, SHA-256 checked, `tools/mavlink-xml/`). The generator applies the
  MAVLink field-ordering and CRC_EXTRA rules itself and fails unless field order,
  types, payload length and CRC_EXTRA all equal pymavlink's. pymavlink is not
  used at runtime.
- On the sample the page reports exactly what the generator wrote: 1,496 valid
  frames, 3 CRC errors, 4 sequence gaps (4 frames missing: the dropped frame and
  the three corrupted ones), 160 skipped bytes. pymavlink's own .tlog reader
  also finds 1,496 valid frames. Decoded fields of 51 frames equal pymavlink's
  values.
- The WebAssembly and native builds report the same frames (offset, id, seq,
  system, component) and the same counters on the sample and on a 3,000-frame
  corrupted stream from `bench/gen_stream.py`.
- Results are the same for chunk sizes 1, 7, 300, 4,096 and 524,288 bytes.
- axe-core 4.14: 0 violations in light and in dark mode, with a frame and with a
  CRC error selected (automated checks only; no screen-reader testing was done).
  No horizontal scrolling at 320 px width.
- A 52 MB capture (the sample repeated) is parsed in 512 kB chunks with a
  progress bar; the longest main-thread block measured in the test was 80 ms
  (the test fails above 250 ms).

CI rebuilds the wasm and fails if it differs from the committed file, checks that
the generated definitions and sample are current, and runs both test files.

### Security review of the browser path

Scanned with semgrep (registry rules for C, JavaScript, HTML, Python, Bash, YAML
and secrets, run from a local copy of semgrep-rules), bandit, the existing
libFuzzer target and a new one for the WebAssembly glue
(`fuzz/fuzz_wasm_glue.c`, built natively with ASan + UBSan; 1,113,923 runs in
61 s, no findings), and the C unit tests under ASan + UBSan. No high-severity
findings in the parser. One real issue in the new JavaScript was found and
fixed: a crafted capture with a fake frame header every 10 bytes produces one
CRC error per 10 bytes, and keeping an object for each made a 50 MB file use
770 MB of JavaScript heap (measured in Node). The page now keeps details for
the first 100,000 issues and counts the rest (19 MB for the same file); the
test `hostile input: issue details are capped, counts stay exact` covers it.
All capture-derived text is inserted with `textContent`.

Add to **Limitations**:

- The inspector decodes payload fields for six messages only; other messages
  show raw payload bytes. Rates need .tlog timestamps. Captures above 512 MB
  are refused. Only the first 100,000 issues are listed (all are counted).
