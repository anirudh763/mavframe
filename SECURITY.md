# Security

mavframe parses bytes from radios and files, which are untrusted input, so
memory-safety problems matter here.

## Maintenance status

Beta, maintained by one student; fixes are best effort and no response time is
promised. Only the latest version on `main` (0.1.x) gets fixes. It is tested on
x86-64 Linux with gcc and clang, and the inspector in Chromium; other platforms
are not supported yet.

## Reporting a problem

Please do not put exploit details in a public issue. If the repository's
**Security** tab shows **Report a vulnerability**, use it. Otherwise open an
issue that says only that you have a security report, and a private contact
will be arranged there.

Fixes come with a regression test (and, for parser bugs, a file in
`fuzz/regressions/`). No personal email is used for reports.

## Supported scope (in)

- `src/mavframe.c` and `include/mavframe.h`: out-of-bounds reads or writes,
  undefined behaviour, hangs, or a frame reported with a wrong CRC, for any input
  bytes.
- `tools/mavframe-dump.c`.
- The browser inspector in `docs/` and its WebAssembly glue
  (`web/wasm/mavframe_wasm.c`): script injection from file contents, a bypass of
  the Content-Security-Policy, or a request that sends file data off the page.

## Out of scope (documented limits, not vulnerabilities)

- Message signatures are carried, not verified.
- A 16-bit CRC accepts random damage about once in 65,536 candidates.
- Crafted input can slow the parser to about 1/19 of normal speed.
- Unknown dialects are dropped; there is no command validation or filtering.

See "Limitations" in the README.

## Checks that already run

CI builds with `-Werror` under gcc and clang, runs the unit and differential
tests under AddressSanitizer and UndefinedBehaviorSanitizer, and fuzzes the
parser and the WebAssembly glue with libFuzzer on every push.
