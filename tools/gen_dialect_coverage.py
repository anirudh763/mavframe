#!/usr/bin/env python3
"""Emit a machine-readable field-by-field inventory for the pinned XML dialect graph."""
import hashlib
import json
import os
import re

from fetch_mavlink_xml import COMMIT, PINS, PYMAVLINK_VERSION, load_graph
from gen_web_defs import parse_message

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFS_PATH = os.path.join(ROOT, "docs", "js", "msgdefs.js")

def main():
    with open(DEFS_PATH, encoding="utf-8") as stream:
        source = stream.read()
    found = re.search(r"export const MESSAGES = (.*);", source)
    if not found:
        raise SystemExit("generated MESSAGES map is missing")
    generated = json.loads(found.group(1))
    graph = load_graph()
    xml_messages = {}
    files = []
    for filename, root in sorted(graph.items()):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mavlink-xml", filename)
        with open(path, "rb") as stream:
            raw = stream.read()
        includes = [item.text.strip() for item in root.findall("include") if item.text]
        message_ids = []
        for element in root.iter("message"):
            message = parse_message(element)
            key = str(message["id"])
            if key in xml_messages:
                raise SystemExit(f"duplicate pinned XML message id {key}")
            xml_messages[key] = message
            message_ids.append(message["id"])
        files.append({"name": filename, "sha256": hashlib.sha256(raw).hexdigest(),
                      "includes": includes, "message_ids": sorted(message_ids)})
    if set(xml_messages) != set(generated):
        raise SystemExit("XML and generated message ID sets differ")
    for message_id, expected in xml_messages.items():
        if expected != generated[message_id]:
            raise SystemExit(f"XML descriptor differs from generated message {message_id}")
    names = json.loads(re.search(r"export const MESSAGE_NAMES = (.*);", source).group(1))
    enums = json.loads(re.search(r"export const ENUMS = (.*);", source).group(1))
    if any(names.get(message_id) != message["name"] for message_id, message in xml_messages.items()):
        raise SystemExit("XML and generated message names differ")
    inventory = {
        "schema": "mavframe-dialect-coverage/1",
        "scope": "all messages and fields in the checksum-pinned MAVLink common + ArduPilotMega include graph",
        "not_claimed": ["other MAVLink dialects", "hardware behavior", "message signatures or sender authentication"],
        "mavlink_xml_commit": COMMIT,
        "pymavlink_reference_version": PYMAVLINK_VERSION,
        "definition_files": files,
        "coverage": {"message_count": len(xml_messages), "field_count": sum(len(message["fields"]) for message in xml_messages.values()),
                     "enum_count": len(enums), "message_ids": sorted(int(value) for value in xml_messages)},
        "messages": [{"id": int(message_id), **xml_messages[message_id]} for message_id in sorted(xml_messages, key=int)],
        "enums": enums,
        "pinned_files": dict(sorted(PINS.items())),
    }
    print(json.dumps(inventory, sort_keys=True, indent=2) + "\n", end="")

if __name__ == "__main__":
    main()
