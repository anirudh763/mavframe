"""Offline parity checks for the checksum-pinned dialect artifacts."""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def generated(script):
    return subprocess.run([sys.executable, os.path.join(ROOT, "tools", script)], cwd=ROOT,
                          check=True, capture_output=True, text=True).stdout


def test_generated_artifacts_match_pinned_xml_and_pymavlink():
    assert generated("gen_crc_extra.py") == open(os.path.join(ROOT, "src", "mavframe_crc_extra_common.h")).read()
    assert generated("gen_web_defs.py") == open(os.path.join(ROOT, "docs", "js", "msgdefs.js")).read()


def test_full_dialect_includes_common_and_ardupilotmega_fields():
    text = open(os.path.join(ROOT, "docs", "js", "msgdefs.js")).read()
    names = json.loads(re.search(r"export const MESSAGE_NAMES = (.*);", text).group(1))
    messages = json.loads(re.search(r"export const MESSAGES = (.*);", text).group(1))
    assert len(names) == len(messages) == 326
    assert names["152"] == "MEMINFO"
    assert [f["name"] for f in messages["76"]["fields"]] == [
        "param1", "param2", "param3", "param4", "param5", "param6", "param7",
        "command", "target_system", "target_component", "confirmation",
    ]
    assert messages["1"]["min_length"] == 31 and messages["1"]["length"] == 43
    assert messages["1"]["fields"][-1]["ext"] is True
    assert messages["152"]["crc_extra"] == 208


def test_machine_readable_coverage_inventory_matches_every_pinned_message_and_field():
    inventory = generated("gen_dialect_coverage.py")
    checked_in = open(os.path.join(ROOT, "docs", "dialect-coverage.json"), encoding="utf-8").read()
    assert inventory == checked_in
    data = json.loads(inventory)
    assert data["coverage"]["message_count"] == 326
    assert data["coverage"]["field_count"] == sum(len(message["fields"]) for message in data["messages"])
    assert data["mavlink_xml_commit"] == "12c898d88ce18d24e8caf6338596e98c5005bc97"
    assert "other MAVLink dialects" in data["not_claimed"]
