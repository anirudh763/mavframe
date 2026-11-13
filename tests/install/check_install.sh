#!/bin/sh
# Build with the default options (MAVFRAME_WERROR off), install into a
# temporary prefix, then compile and run tests/install/consumer.c against the
# installed header and library only. CI runs this with CC=clang.
#
#     sh tests/install/check_install.sh
set -eu
cd "$(dirname "$0")/../.."
cc=${CC:-cc}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

version=$(sed -n 's/^#define MAVFRAME_VERSION_STRING "\(.*\)"$/\1/p' include/mavframe.h)
[ -n "$version" ] || fail "no MAVFRAME_VERSION_STRING in include/mavframe.h"

# -Werror is opt-in: absent by default, present with -DMAVFRAME_WERROR=ON.
CC=$cc cmake -S . -B "$work/build" -DCMAKE_EXPORT_COMPILE_COMMANDS=ON >/dev/null
if grep -q -- '-Werror' "$work/build/compile_commands.json"; then fail "-Werror is on by default"; fi
CC=$cc cmake -S . -B "$work/build-werror" -DMAVFRAME_WERROR=ON -DCMAKE_EXPORT_COMPILE_COMMANDS=ON >/dev/null
grep -q -- '-Werror' "$work/build-werror/compile_commands.json" || fail "MAVFRAME_WERROR=ON does not add -Werror"

cmake --build "$work/build" --target mavframe mavframe-dump
cmake --install "$work/build" --prefix "$work/prefix"
echo "installed files:"
(cd "$work/prefix" && find . -type f | sort)

lib=$(find "$work/prefix" -name libmavframe.a)
[ -n "$lib" ] || fail "libmavframe.a was not installed"
[ -f "$work/prefix/include/mavframe.h" ] || fail "mavframe.h was not installed"
[ -x "$work/prefix/bin/mavframe-dump" ] || fail "mavframe-dump was not installed"

# Only the installed files: the consumer is compiled outside the source tree.
cp tests/install/consumer.c "$work/consumer.c"
(cd "$work" && "$cc" -std=c99 -Wall -Wextra -Wpedantic -Werror consumer.c \
    -I"$work/prefix/include" -L"$(dirname "$lib")" -lmavframe -o consumer)
out=$("$work/consumer")
echo "$out"
[ "$out" = "mavframe $version crc=0x6F91" ] || fail "consumer printed: $out"

dump=$("$work/prefix/bin/mavframe-dump" --version)
echo "$dump"
[ "$dump" = "mavframe-dump $version" ] || fail "installed mavframe-dump --version: $dump"
echo "install check passed"
