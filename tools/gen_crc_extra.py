#!/usr/bin/env python3
"""Generate the common + ardupilotmega CRC_EXTRA lookup table offline.

Usage: python3 tools/gen_crc_extra.py > src/mavframe_crc_extra_common.h
"""
import sys

import pymavlink

from fetch_mavlink_xml import COMMIT, load_graph, load_pymavlink_dialect


def main():
    graph = load_graph()
    mav = load_pymavlink_dialect()
    xml_messages = {int(m.get("id")): m.get("name") for root in graph.values() for m in root.iter("message")}
    entries = sorted((msgid, cls.crc_extra, cls.msgname) for msgid, cls in mav.mavlink_map.items())
    if {msgid: name for msgid, _, name in entries} != xml_messages:
        sys.exit("pymavlink ardupilotmega message set differs from pinned XML at %s" % COMMIT)

    print("/*")
    print(" * GENERATED FILE, do not edit.")
    print(" * CRC_EXTRA values for common + ardupilotmega, cross-checked against")
    print(" * pinned MAVLink XML commit %s and pymavlink %s." % (COMMIT, pymavlink.__version__))
    print(" * Regenerate with: python3 tools/gen_crc_extra.py > src/mavframe_crc_extra_common.h")
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
