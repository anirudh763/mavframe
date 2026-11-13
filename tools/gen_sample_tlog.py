#!/usr/bin/env python3
"""Generate the synthetic sample capture for the browser inspector.

    python3 tools/gen_sample_tlog.py

writes
    docs/sample/sample-flight.tlog    60 s of telemetry, a few defects on purpose
    tests/web/sample-truth.json       what an inspector must report for it

The flight is made up: a quadrotor climbs to 50 m and flies a circle near the
PX4 simulator's default home position. Every frame is packed by pymavlink
(common dialect, MAVLink v2). Each .tlog record is an 8-byte big-endian
timestamp in microseconds followed by one frame.

Defects, all at fixed places so the counts below are exact:
  * 3 frames have one byte changed after packing (CRC errors);
  * 1 GPS_RAW_INT frame is packed (its sequence number is used) but never
    written, so the autopilot's sequence numbers jump (a gap);
  * 1 record holds a MAVLink v1 HEARTBEAT from a second system; the parser
    handles v2 only, so its bytes count as skipped.

The truth file is computed from this generator's own record list, not by
running mavframe, and is then cross-checked with pymavlink's .tlog reader.
"""
import json
import math
import os
import random
import struct
import sys

from pymavlink import mavutil
from pymavlink.dialects.v10 import common as mav1
from pymavlink.dialects.v20 import common as mav

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TLOG = os.path.join(ROOT, "docs", "sample", "sample-flight.tlog")
TRUTH = os.path.join(ROOT, "tests", "web", "sample-truth.json")

START_US = 1767225600 * 1000000  # 2026-01-01 00:00:00 UTC
DURATION_S = 60
HOME_LAT, HOME_LON = 47.397742, 8.545594  # PX4 SITL default home
RADIUS_M, SPEED_MS, ALT_M = 80.0, 12.0, 50.0

# (message, rate in Hz)
SCHEDULE = [("HEARTBEAT", 1), ("SYS_STATUS", 1), ("SYSTEM_TIME", 1), ("GPS_RAW_INT", 2),
            ("VFR_HUD", 4), ("GLOBAL_POSITION_INT", 5), ("ATTITUDE", 10)]
# (message, index of its occurrence) -> payload byte to XOR with 0x55
CORRUPT = {("ATTITUDE", 123): 5, ("GLOBAL_POSITION_INT", 155): 9, ("VFR_HUD", 188): 2}
DROP = {("GPS_RAW_INT", 80)}
V1_AT_S = 20.5
DECODE_EVERY = 25  # store pymavlink-decoded fields for every 25th written frame


def state(t):
    """Synthetic vehicle state at t seconds."""
    climb = min(t / 10.0, 1.0)
    alt = ALT_M * climb
    ang = SPEED_MS / RADIUS_M * max(t - 10.0, 0.0)
    north, east = RADIUS_M * math.sin(ang), RADIUS_M * (1 - math.cos(ang))
    lat = HOME_LAT + north / 111320.0
    lon = HOME_LON + east / (111320.0 * math.cos(math.radians(HOME_LAT)))
    heading = (math.degrees(ang) + 90.0) % 360.0 if t > 10 else 90.0
    speed = SPEED_MS if t > 10 else 0.0
    return {"lat": lat, "lon": lon, "alt": alt, "heading": heading, "speed": speed,
            "climb": 5.0 if t < 10 else 0.0, "roll": math.radians(10.4) if t > 10 else 0.0,
            "pitch": math.radians(-3.0) if t > 10 else 0.0, "yaw": math.radians(heading if heading <= 180 else heading - 360),
            "batt": 1.0 - 0.0012 * t}


def build(name, t, rng):
    s = state(t)
    boot_ms = int(t * 1000) + 15000
    vn = s["speed"] * math.cos(math.radians(s["heading"]))
    ve = s["speed"] * math.sin(math.radians(s["heading"]))
    if name == "HEARTBEAT":
        return mav.MAVLink_heartbeat_message(
            mav.MAV_TYPE_QUADROTOR, mav.MAV_AUTOPILOT_PX4,
            mav.MAV_MODE_FLAG_SAFETY_ARMED | mav.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, 0x04040000,
            mav.MAV_STATE_ACTIVE, 3)
    if name == "SYS_STATUS":
        sensors = 0x0020FC2F
        return mav.MAVLink_sys_status_message(
            sensors, sensors, sensors, 410 + rng.randint(0, 40), int(16400 - 8 * t), 1230 + rng.randint(-20, 20),
            int(round(100 * s["batt"])), 0, 0, 0, 0, 0, 0)
    if name == "SYSTEM_TIME":
        return mav.MAVLink_system_time_message(START_US + int(t * 1e6), boot_ms)
    if name == "GPS_RAW_INT":
        return mav.MAVLink_gps_raw_int_message(
            START_US + int(t * 1e6), mav.GPS_FIX_TYPE_3D_FIX, int(s["lat"] * 1e7), int(s["lon"] * 1e7),
            int((488.0 + s["alt"]) * 1000), 78, 112, int(s["speed"] * 100), int(s["heading"] * 100), 14)
    if name == "VFR_HUD":
        return mav.MAVLink_vfr_hud_message(s["speed"], s["speed"], int(s["heading"]), 55 if t > 10 else 62,
                                           s["alt"], s["climb"])
    if name == "GLOBAL_POSITION_INT":
        return mav.MAVLink_global_position_int_message(
            boot_ms, int(s["lat"] * 1e7), int(s["lon"] * 1e7), int((488.0 + s["alt"]) * 1000),
            int(s["alt"] * 1000), int(vn * 100), int(ve * 100), int(-s["climb"] * 100), int(s["heading"] * 100))
    if name == "ATTITUDE":
        return mav.MAVLink_attitude_message(boot_ms, s["roll"] + rng.uniform(-0.01, 0.01),
                                            s["pitch"] + rng.uniform(-0.01, 0.01), s["yaw"],
                                            rng.uniform(-0.02, 0.02), rng.uniform(-0.02, 0.02), SPEED_MS / RADIUS_M)
    raise ValueError(name)


def plain(value, ftype):
    """JSON-friendly field value. 64-bit integers become decimal strings,
    because JavaScript reads them as BigInt."""
    if isinstance(value, list):
        return [plain(v, ftype) for v in value]
    if isinstance(value, bytes):
        return value.decode("latin-1")
    if ftype in ("uint64_t", "int64_t"):
        return str(value)
    return value


def pack(msg, link):
    """Pack like MAVLink.send() does: pack() itself does not advance seq."""
    frame = bytearray(msg.pack(link))
    link.seq = (link.seq + 1) % 256
    return frame


def main():
    rng = random.Random(2026)
    autopilot = mav.MAVLink(None, srcSystem=1, srcComponent=1)
    gcs = mav.MAVLink(None, srcSystem=255, srcComponent=190)
    companion = mav1.MAVLink(None, srcSystem=2, srcComponent=191)

    events = []  # (time s, order, kind, message name, link)
    for order, (name, hz) in enumerate(SCHEDULE):
        for i in range(DURATION_S * hz):
            events.append((i / hz + 0.003 * order, order, name, i))
    for i in range(DURATION_S):
        events.append((i + 0.5, 99, "GCS_HEARTBEAT", i))
    events.sort()

    out = bytearray()
    records = []  # dicts describing every written record
    for t, _, name, index in events:
        if V1_AT_S <= t and not any(r["kind"] == "v1" for r in records):
            frame = bytes(pack(mav1.MAVLink_heartbeat_message(
                mav1.MAV_TYPE_ONBOARD_CONTROLLER, mav1.MAV_AUTOPILOT_INVALID, 0, 0, mav1.MAV_STATE_ACTIVE, 3
            ), companion))
            ts = START_US + int(V1_AT_S * 1e6)
            records.append({"kind": "v1", "ts": ts, "offset": len(out) + 8, "len": len(frame)})
            out += struct.pack(">Q", ts) + frame
        ts = START_US + int(round(t * 1e6)) + rng.randint(0, 900)
        if name == "GCS_HEARTBEAT":
            msg = mav.MAVLink_heartbeat_message(mav.MAV_TYPE_GCS, mav.MAV_AUTOPILOT_INVALID, 0, 0,
                                                mav.MAV_STATE_ACTIVE, 3)
            frame = pack(msg, gcs)
        else:
            msg = build(name, t, rng)
            frame = pack(msg, autopilot)
        if (name, index) in DROP:
            continue  # packed (sequence number used) but lost on the link
        kind = "ok"
        if (name, index) in CORRUPT:
            frame[10 + CORRUPT[(name, index)]] ^= 0x55
            kind = "crc"
        rec = {"kind": kind, "ts": ts, "offset": len(out) + 8, "len": len(frame), "msgid": msg.get_msgId(),
               "name": msg.get_type(), "sysid": frame[5], "compid": frame[6], "seq": frame[4]}
        if kind == "ok" and sum(1 for r in records if r["kind"] == "ok") % DECODE_EVERY == 0:
            types = dict(zip(msg.fieldnames, msg.fieldtypes))
            rec["fields"] = {k: plain(getattr(msg, k), types[k]) for k in msg.fieldnames}
        records.append(rec)
        out += struct.pack(">Q", ts) + bytes(frame)

    os.makedirs(os.path.dirname(TLOG), exist_ok=True)
    with open(TLOG, "wb") as f:
        f.write(out)

    ok = [r for r in records if r["kind"] == "ok"]
    per_msg = {}
    for r in records:
        if r["kind"] in ("ok", "crc"):
            e = per_msg.setdefault(str(r["msgid"]), {"name": r["name"], "count": 0, "crc_errors": 0})
            e["count" if r["kind"] == "ok" else "crc_errors"] += 1
    # Sequence findings per (system, component), same rule as the inspector:
    # step 1 in order, 0 duplicate, 2..128 gap (step-1 missing if in order),
    # 129..255 backwards (late frame if <= 16 back, otherwise a reset).
    gaps, missing, duplicates, reorders, last = [], 0, 0, 0, {}
    for r in ok:
        key = (r["sysid"], r["compid"])
        if key not in last:
            last[key] = r["seq"]
            continue
        d = (r["seq"] - last[key]) & 0xFF
        if d == 1:
            last[key] = r["seq"]
        elif d == 0:
            duplicates += 1
        elif d <= 128:
            gaps.append({"offset": r["offset"], "sysid": r["sysid"], "compid": r["compid"], "missing": d - 1})
            missing += d - 1
            last[key] = r["seq"]
        else:
            reorders += 1
            if 256 - d > 16:
                last[key] = r["seq"]

    # Cross-check with pymavlink's own .tlog reader (robust parsing).
    log = mavutil.mavlink_connection(TLOG, dialect="common", robust_parsing=True)
    py_frames, py_bad = 0, 0
    while True:
        m = log.recv_msg()
        if m is None:
            break
        if m.get_type() == "BAD_DATA":
            py_bad += 1
        elif m.get_type() != "HEARTBEAT" or m.get_srcSystem() != 2:  # the v1 record
            py_frames += 1
    if py_frames != len(ok):
        sys.exit("pymavlink read %d valid v2 frames, generator wrote %d" % (py_frames, len(ok)))

    truth = {
        "file": "docs/sample/sample-flight.tlog",
        "bytes": len(out),
        "records": len(records),
        "frames": len(ok),
        "crc_errors": sum(1 for r in records if r["kind"] == "crc"),
        "gaps": len(gaps),
        "missing_frames": missing,
        "duplicates": duplicates,
        "reorders": reorders,
        "gap_list": gaps,
        "skipped_bytes": len(out) - sum(r["len"] for r in ok) - 8 * len(ok),
        "v1_records": sum(1 for r in records if r["kind"] == "v1"),
        "first_ts_us": ok[0]["ts"],
        "last_ts_us": ok[-1]["ts"],
        "messages": per_msg,
        "pymavlink_tlog_reader": {"valid_v2_frames": py_frames, "bad_data_pieces": py_bad},
        "crc_error_offsets": [r["offset"] for r in records if r["kind"] == "crc"],
        "decoded": [{"offset": r["offset"], "msgid": r["msgid"], "name": r["name"], "fields": r["fields"]}
                    for r in ok if "fields" in r],
    }
    os.makedirs(os.path.dirname(TRUTH), exist_ok=True)
    with open(TRUTH, "w", encoding="utf-8") as f:
        json.dump(truth, f, indent=1, sort_keys=True)
        f.write("\n")
    print("wrote %s (%d bytes, %d frames, %d CRC errors, %d gaps)" % (
        TLOG, len(out), len(ok), truth["crc_errors"], len(gaps)))


if __name__ == "__main__":
    main()
