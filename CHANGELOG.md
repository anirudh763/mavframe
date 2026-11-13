# Changelog

## Unreleased

Browser inspector rebuild (UI only: `src/`, `include/`, `web/wasm/` and
`docs/mavframe.wasm` are byte-identical to 0.1.0).

- Light by default, also when the OS prefers dark; dark only through the
  "Dark theme" toggle. New tokens and layout in `DESIGN.md`.
- Hash routes: Capture, Frames, Frame details (`#/frames/<row>`), Format help,
  Not found. Old `#view=…&msg=…&sel=…` links are mapped to them.
- Packet-analyzer layout: frame rows (time, offset, message, sys:comp, seq,
  CRC status) with filters, linked field tree and hex bytes, CRC wire vs
  computed side by side.
- Finding export (JSON) without position payload bytes by default.
- Tests: `tests/web/test_routes.mjs` (root visual gate) and
  `tests/web/test_finding.mjs` (row model, export).

## 0.1.0 – 2026-11-13

First numbered version. The parser (`src/mavframe.c`), its events and counters,
and `docs/mavframe.wasm` are unchanged (the wasm rebuilt with zig 0.17.1 is
byte-identical to the committed file).

- Version: `MAVFRAME_VERSION_MAJOR`, `_MINOR`, `_PATCH` and `MAVFRAME_VERSION_STRING`
  in `mavframe.h`, and `project(mavframe VERSION 0.1.0)` in CMake.
  `tests/test_version.py` fails if they or the top entry of this file disagree.
- `-Werror` is now the option `MAVFRAME_WERROR` (off by default, on in CI), so a
  newer compiler with new warnings does not break a user's build.
- `cmake --install build --prefix <dir>` installs `lib/libmavframe.a`,
  `include/mavframe.h` and `bin/mavframe-dump`. A CI job builds with clang and
  the default options, installs into a temporary prefix, and compiles and runs a
  5-line program (`tests/install/consumer.c`) against the installed files only.
- `mavframe-dump` takes an optional `FILE` argument (`-` or nothing reads stdin)
  and `--help`/`--version` (both print to stdout and exit 0). A file that cannot
  be opened or read gives `mavframe-dump: cannot open <file>: <reason>` and exit
  status 1; bad arguments give exit status 2. File and stdin modes print the same
  output (`tests/test_cli.py`). A read error no longer prints a counter line.
- Inspector page: a `<noscript>` message when JavaScript is off, and an SVG
  favicon. The axe-core gate now runs at 1280 and 375 px, in light and dark.
- `SECURITY.md` (beta status, how to report, supported scope), `CONTRIBUTING.md`
  and two issue templates.
- The MIT notice for the MAVLink XML definitions (the excerpt in
  `tools/mavlink-xml/` and the generated `docs/js/msgdefs.js`) now ships next to
  them and is linked from the page footer.
- README: what the tool is for in one line at the top, the firmware-style wording
  matched to "never run on a microcontroller", and a note that no capture from a
  real radio link has been tested yet.

## Before 0.1.0

The parser, differential tests against pymavlink, fuzz targets, benchmark and the
browser inspector were built before versions were numbered; see the git history.
