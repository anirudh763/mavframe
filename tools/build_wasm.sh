#!/bin/sh
# Build docs/mavframe.wasm from the unchanged parser source (src/mavframe.c)
# plus the browser glue in web/wasm/. Needs only the zig toolchain from PyPI:
#
#     pip install ziglang==0.17.1
#     sh tools/build_wasm.sh            # writes docs/mavframe.wasm
#     sh tools/build_wasm.sh out.wasm   # or another path (CI compares)
#
# The output is byte-for-byte reproducible for a given zig version: no debug
# info, no build paths, and the committed file is checked in CI.
set -eu
cd "$(dirname "$0")/.."
out=${1:-docs/mavframe.wasm}

# The only C files compiled. The parser is src/mavframe.c itself, never a
# copy; tests/web/test_wasm.mjs reads this line from the output (and the
# actual compiler command via sh -x) and fails on any other list.
sources="src/mavframe.c web/wasm/mavframe_wasm.c"
echo "sources: $sources"

exports=""
for sym in mfw_reset mfw_input mfw_input_cap mfw_events mfw_event_cap mfw_event_count \
           mfw_stats mfw_feed mfw_flush mfw_scratch mavframe_crc16 mavframe_crc_extra; do
    exports="$exports -Wl,--export=$sym"
done

# shellcheck disable=SC2086
python3 -m ziglang cc \
    -target wasm32-freestanding \
    -std=c99 -O2 -fno-builtin \
    -Wall -Wextra -Wpedantic -Werror \
    -nostdlib -Wl,--no-entry -Wl,--strip-all -s \
    $exports \
    -Iweb/wasm/include -Iinclude \
    $sources \
    -o "$out"
echo "wrote $out ($(wc -c < "$out" | tr -d ' ') bytes)"
