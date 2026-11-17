#!/usr/bin/env python3
"""Regenerate the small, synthetic public demo fixtures with pymavlink v20 common."""
import struct
from pathlib import Path
from pymavlink.dialects.v20 import common as mav

OUT = Path(__file__).resolve().parents[1] / "docs/sample"
START = 1_700_000_000_000_000


def write(name, messages, corrupt=False):
    encoder = mav.MAVLink(None, srcSystem=1, srcComponent=1)
    records = []
    for index, message in enumerate(messages):
        encoder.seq = index
        packet = bytearray(message.pack(encoder))
        if corrupt:
            packet[-1] ^= 1  # Deliberately damage only the high CRC byte.
        records.append(struct.pack(">Q", START + index * 1_000_000) + packet)
    (OUT / f"scenario-{name}.tlog").write_bytes(b"".join(records))


def heartbeat():
    return mav.MAVLink_heartbeat_message(2, 3, 0, 0, 3, 3)


def gps(lat, lon):
    return mav.MAVLink_gps_raw_int_message(START, 3, lat, lon, 120000, 100, 100, 0, 0, 12)


def position(ms, height):
    return mav.MAVLink_global_position_int_message(ms, 410000000, -870000000, 120000, height, 0, 0, 0, 0)


write("heartbeat", [heartbeat(), heartbeat()])
write("gps", [gps(410000000, -870000000), gps(410100000, -870000000)])
write("altitude-control", [position(1000, 10000),
    mav.MAVLink_command_long_message(1, 1, mav.MAV_CMD_DO_CHANGE_ALTITUDE, 0, 110, mav.MAV_FRAME_GLOBAL_RELATIVE_ALT, 0, 0, 0, 0, 0),
    position(3000, 110000)])
write("crc", [heartbeat()], corrupt=True)
