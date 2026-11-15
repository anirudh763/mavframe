---
name: binary-fuzz-qa
description: Verify Native C and browser Wasm MAVLink parsing/fuzzing with reproducible real-engine edge cases and browser evidence.
---

# Domain acceptance

Use the exact repository engine, published fixtures and existing tests. Add reproducible cases for the following; record pass/fail/untested, versions and evidence for each.

1. Valid MAVLinkv1/v2 heartbeat and telemetry frames through the exact native C/Wasm parser.
2. Truncated headers and payloads: bounded safe rejection/incomplete input semantics.
3. Invalid CRC-16: native rejection, highlighted failing byte/offset where known.
4. Sequence gaps and out-of-order/replayed frames: report actual sequence diagnostics; do not invent authentication or parser rejection if protocol does not guarantee it.
5. Oversized/malformed length fields: no out-of-bounds access; native sanitizer evidence and browser rejection.
6. Empty input and seeded random noise; Run 1,000 iterations must execute actual C/Wasm calls with bounded work, cancel and real timings.
7. Differential native C versus Wasm: identical outputs for the versioned test corpus, including mutations. State corpus size;100%of a corpus is not proof for all byte strings.

Run the relevant native/Python/Node/browser checks and inspect 320/768/1440 UI states. Zero errors/leaks means none observed in the named finite run, not a universal guarantee. Preserve meaningful assertion strength; diagnose platform/toolchain differences rather than skipping failing cases. No secrets or user payloads in reports.
