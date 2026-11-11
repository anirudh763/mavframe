#!/usr/bin/env python3
"""Generate src/mavframe_crc_extra_common.h from pymavlink.

Usage (from the repository root):
    pip install pymavlink
    python3 tools/gen_crc_extra.py > src/mavframe_crc_extra_common.h
"""
import pymavlink
from pymavlink.dialects.v20 import common


def main():
    entries = sorted((msgid, cls.crc_extra, cls.msgname) for msgid, cls in common.mavlink_map.items())
    print("/*")
    print(" * GENERATED FILE, do not edit.")
    print(" * CRC_EXTRA values for the MAVLink 'common' dialect, taken from")
    print(" * pymavlink %s (pymavlink.dialects.v20.common)." % pymavlink.__version__)
    print(" * Regenerate with:")
    print(" *     python3 tools/gen_crc_extra.py > src/mavframe_crc_extra_common.h")
    print(" * Each entry is (msgid << 8) | crc_extra, sorted by msgid for binary search.")
    print(" */")
    print("#ifndef MAVFRAME_CRC_EXTRA_COMMON_H")
    print("#define MAVFRAME_CRC_EXTRA_COMMON_H")
    print()
    print("#include <stdint.h>")
    print()
    print("#define MAVFRAME_CRC_EXTRA_COUNT %d" % len(entries))
    print()
    print("static const uint32_t mavframe_crc_extra_table[MAVFRAME_CRC_EXTRA_COUNT] = {")
    for msgid, extra, name in entries:
        print("    0x%08XU, /* %5d %s = %d */" % ((msgid << 8) | extra, msgid, name, extra))
    print("};")
    print()
    print("#endif /* MAVFRAME_CRC_EXTRA_COMMON_H */")


if __name__ == "__main__":
    main()
