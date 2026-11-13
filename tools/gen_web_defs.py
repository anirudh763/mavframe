#!/usr/bin/env python3
"""Generate docs/js/msgdefs.js for the browser inspector.

Payload layouts come from the official definitions in
tools/mavlink-xml/common-excerpt.xml (see tools/fetch_mavlink_xml.py). The
MAVLink rules are applied here: base fields sorted by type size (largest
first, stable), extension fields appended in XML order, CRC_EXTRA over the
base fields. pymavlink is used only to check the result (field order, types,
array lengths, payload length, CRC_EXTRA) and for the list of message names.

    python3 tools/gen_web_defs.py > docs/js/msgdefs.js
"""
import json
import os
import sys
import xml.etree.ElementTree as ET

from pymavlink.dialects.v20 import common as mav

HERE = os.path.dirname(os.path.abspath(__file__))
XML = os.path.join(HERE, "mavlink-xml", "common-excerpt.xml")

SIZES = {"char": 1, "uint8_t": 1, "int8_t": 1, "uint16_t": 2, "int16_t": 2, "uint32_t": 4,
         "int32_t": 4, "float": 4, "uint64_t": 8, "int64_t": 8, "double": 8}


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
    f = {"name": el.get("name"), "type": t, "count": count, "ext": extension}
    for attr in ("units", "enum"):
        if el.get(attr):
            f[attr] = el.get(attr)
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
    base_sorted = sorted(base, key=lambda f: -SIZES[f["type"]])  # sorted() is stable
    crc = x25((m.get("name") + " ").encode())
    for f in base_sorted:
        crc = x25((f["type"] + " ").encode(), crc)
        crc = x25((f["name"] + " ").encode(), crc)
        if f["count"]:
            crc = x25(bytes([f["count"]]), crc)
    fields, off = [], 0
    for f in base_sorted + ext:
        f["offset"] = off
        off += SIZES[f["type"]] * max(f["count"], 1)
        fields.append(f)
    desc = (m.findtext("description") or "").strip().split(". ")[0].rstrip(".") + "."
    return {"id": int(m.get("id")), "name": m.get("name"), "description": " ".join(desc.split()),
            "length": off, "crc_extra": (crc & 0xFF) ^ (crc >> 8), "fields": fields}


def check_against_pymavlink(msg):
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
        sys.exit("%s differs from pymavlink: %s" % (msg["name"], "; ".join(problems)))


def main():
    root = ET.parse(XML).getroot()
    messages = [parse_message(m) for m in root.iter("message")]
    for m in messages:
        check_against_pymavlink(m)
    enums = {}
    for e in root.iter("enum"):
        enums[e.get("name")] = {
            "bitmask": e.get("bitmask") == "true",
            "entries": {int(x.get("value")): x.get("name") for x in e.iter("entry")},
        }
    names = {k: mav.mavlink_map[k].msgname for k in sorted(mav.mavlink_map)}

    def js(obj):
        return json.dumps(obj, indent=None, separators=(",", ":"), sort_keys=True)

    print("// GENERATED FILE, do not edit. Regenerate with:")
    print("//     python3 tools/gen_web_defs.py > docs/js/msgdefs.js")
    print("// Payload layouts: official MAVLink XML (tools/mavlink-xml/common-excerpt.xml),")
    print("// checked against pymavlink %s. Names: all %d messages of the common dialect."
          % (__import__("pymavlink").__version__, len(names)))
    print("export const MESSAGE_NAMES = %s;" % js(names))
    print("export const MESSAGES = %s;" % js({m["id"]: m for m in messages}))
    print("export const ENUMS = %s;" % js(enums))


if __name__ == "__main__":
    main()
