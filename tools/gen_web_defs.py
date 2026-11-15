#!/usr/bin/env python3
"""Generate browser payload metadata from pinned common + ArduPilot XML.

Usage: python3 tools/gen_web_defs.py > docs/js/msgdefs.js
"""
import json
import sys

import pymavlink

from fetch_mavlink_xml import COMMIT, PYMAVLINK_VERSION, load_graph, load_pymavlink_dialect

SIZES = {"char": 1, "uint8_t": 1, "int8_t": 1, "uint16_t": 2, "int16_t": 2,
         "uint32_t": 4, "int32_t": 4, "float": 4, "uint64_t": 8, "int64_t": 8, "double": 8}
LIMITS = {"UINT8_MAX": 2**8 - 1, "UINT16_MAX": 2**16 - 1, "UINT32_MAX": 2**32 - 1,
          "INT8_MAX": 2**7 - 1, "INT16_MAX": 2**15 - 1, "INT32_MAX": 2**31 - 1}


def x25(data, crc=0xFFFF):
    for b in data:
        tmp = (b ^ (crc & 0xFF)) & 0xFF
        tmp = (tmp ^ (tmp << 4)) & 0xFF
        crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF
    return crc


def parse_field(el, extension):
    t = el.get("type")
    count = 0
    if "[" in t:
        t, n = t[:-1].split("[")
        count = int(n)
    if t == "uint8_t_mavlink_version":
        t = "uint8_t"
    if t not in SIZES:
        raise ValueError("unsupported MAVLink field type %s" % t)
    f = {"name": el.get("name"), "type": t, "count": count, "ext": extension}
    for attr in ("units", "enum"):
        if el.get(attr):
            f[attr] = el.get(attr)
    if el.get("invalid") is not None:
        inv = el.get("invalid")
        if inv in LIMITS:
            f["invalid"] = LIMITS[inv]
        else:
            try:
                f["invalid"] = int(inv)
            except ValueError:
                f["invalid"] = inv
    if el.get("display") == "bitmask":
        f["bitmask"] = True
    return f


def parse_message(m):
    base, ext, in_ext = [], [], False
    for child in m:
        if child.tag == "extensions":
            in_ext = True
        elif child.tag == "field":
            (ext if in_ext else base).append(parse_field(child, in_ext))
    base_sorted = sorted(base, key=lambda f: -SIZES[f["type"]])
    crc = x25((m.get("name") + " ").encode())
    for f in base_sorted:
        crc = x25((f["type"] + " ").encode(), crc)
        crc = x25((f["name"] + " ").encode(), crc)
        if f["count"]:
            crc = x25(bytes([f["count"]]), crc)
    fields, off = [], 0
    for f in base_sorted:
        f["offset"] = off
        off += SIZES[f["type"]] * max(f["count"], 1)
        fields.append(f)
    min_length = off
    for f in ext:
        f["offset"] = off
        off += SIZES[f["type"]] * max(f["count"], 1)
        fields.append(f)
    desc = (m.findtext("description") or "").strip().split(". ")[0].rstrip(".") + "."
    return {"id": int(m.get("id")), "name": m.get("name"), "description": " ".join(desc.split()),
            "min_length": min_length, "length": off, "crc_extra": (crc & 0xFF) ^ (crc >> 8), "fields": fields}


def check_against_pymavlink(msg, mav):
    cls = mav.mavlink_map[msg["id"]]
    problems = []
    if cls.msgname != msg["name"]:
        problems.append("name %s" % cls.msgname)
    if cls.crc_extra != msg["crc_extra"]:
        problems.append("crc_extra %d != %d" % (msg["crc_extra"], cls.crc_extra))
    if list(cls.ordered_fieldnames) != [f["name"] for f in msg["fields"]]:
        problems.append("field order %s" % (cls.ordered_fieldnames,))
    types = dict(zip(cls.fieldnames, cls.fieldtypes))
    lens = dict(zip(cls.ordered_fieldnames, cls.array_lengths))
    for f in msg["fields"]:
        if types.get(f["name"]) != f["type"] or lens.get(f["name"]) != f["count"]:
            problems.append("field %s" % f["name"])
    if cls.unpacker.size != msg["length"]:
        problems.append("length %d != %d" % (msg["length"], cls.unpacker.size))
    if problems:
        raise ValueError("%s differs from pymavlink: %s" % (msg["name"], "; ".join(problems)))


def main():
    if pymavlink.__version__ != PYMAVLINK_VERSION:
        sys.exit("expected pymavlink %s, got %s" % (PYMAVLINK_VERSION, pymavlink.__version__))
    graph = load_graph()
    mav = load_pymavlink_dialect()
    messages_by_id, enums_by_name = {}, {}
    for root in graph.values():
        for m in root.iter("message"):
            msg = parse_message(m)
            if msg["id"] in messages_by_id:
                raise ValueError("duplicate message id %d" % msg["id"])
            messages_by_id[msg["id"]] = msg
        for e in root.iter("enum"):
            values = {int(x.get("value")): x.get("name") for x in e.iter("entry")}
            enum = enums_by_name.setdefault(e.get("name"),
                                            {"bitmask": e.get("bitmask") == "true", "entries": {}})
            for value, name in values.items():
                if value in enum["entries"] and enum["entries"][value] != name:
                    raise ValueError("conflicting enum %s value %d" % (e.get("name"), value))
                enum["entries"][value] = name
    if set(messages_by_id) != set(mav.mavlink_map):
        sys.exit("pymavlink ardupilotmega message ids differ from pinned XML")
    if set(enums_by_name) != set(mav.enums):
        sys.exit("pymavlink ardupilotmega enum names differ from pinned XML")
    for name, enum in enums_by_name.items():
        py_enum = mav.enums[name]
        py_entries = {value: entry.name for value, entry in py_enum.items()
                      if entry.name != name + "_ENUM_END"}
        if py_enum.bitmask != enum["bitmask"] or py_entries != enum["entries"]:
            sys.exit("pymavlink enum %s differs from pinned XML" % name)
    messages = [messages_by_id[k] for k in sorted(messages_by_id)]
    for msg in messages:
        check_against_pymavlink(msg, mav)
    names = {k: mav.mavlink_map[k].msgname for k in sorted(mav.mavlink_map)}

    def js(obj):
        return json.dumps(obj, separators=(",", ":"), sort_keys=True)

    print("// GENERATED FILE, do not edit. Regenerate with:")
    print("//     python3 tools/gen_web_defs.py > docs/js/msgdefs.js")
    print("// Payload layouts: checksum-pinned MAVLink XML commit %s," % COMMIT)
    print("// checked against pymavlink %s. Includes common + ardupilotmega." % pymavlink.__version__)
    print("export const MESSAGE_NAMES = %s;" % js(names))
    print("export const MESSAGES = %s;" % js({m["id"]: m for m in messages}))
    print("export const ENUMS = %s;" % js(enums_by_name))


if __name__ == "__main__":
    main()
