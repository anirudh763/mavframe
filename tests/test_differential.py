"""Differential tests: the same bytes go to mavframe-dump and to pymavlink's
parser (robust_parsing=True); the decoded frame sequences are compared.

Run from the repository root after building:  python3 -m pytest tests -v
Numbers for the README come from:             python3 tests/report.py
"""
import os

import pytest
from pymavlink.dialects.v20 import common as mav

import harness as h

CLEAN_SEED = 1
CORRUPT_SEEDS = [2, 3, 4]
FRAMES_PER_STREAM = 5000


def test_dump_binary_exists():
    assert os.path.exists(h.DUMP), "build first: cmake -S . -B build && cmake --build build"


def test_generator_covers_many_message_types():
    frames = h.make_frames(CLEAN_SEED, FRAMES_PER_STREAM)
    ids = {f[7] | f[8] << 8 | f[9] << 16 for f in frames}
    assert len(ids) == len(mav.mavlink_map)  # every message of the common dialect
    assert any(f[2] & 1 for f in frames)     # some signed
    assert max(f[1] for f in frames) == 255  # some with the largest payload


def test_clean_stream_sequences_identical():
    data, truth = h.clean_stream(h.make_frames(CLEAN_SEED, FRAMES_PER_STREAM))
    mf_keys, counters = h.run_mavframe(data)
    py_keys, spans, consumed = h.run_pymavlink(data)
    assert mf_keys == truth
    assert py_keys == truth
    assert consumed == len(data)
    assert counters == {"bytes": len(data), "frames": FRAMES_PER_STREAM, "bad_crc": 0,
                        "unknown_msgid": 0, "bad_flags": 0, "dropped_bytes": 0}


def test_one_frame_of_every_message_type():
    import random
    rng = random.Random(7)
    link = mav.MAVLink(None, srcSystem=9, srcComponent=8)
    frames = [bytes(h.random_message(rng, mav.mavlink_map[k]).pack(link)) for k in sorted(mav.mavlink_map)]
    data, truth = h.clean_stream(frames)
    mf_keys, _ = h.run_mavframe(data)
    py_keys, _, _ = h.run_pymavlink(data)
    assert mf_keys == truth == py_keys
    assert [k[1] for k in mf_keys] == sorted(mav.mavlink_map)


@pytest.mark.parametrize("seed", CORRUPT_SEEDS)
def test_corrupted_stream_every_difference_explained(seed):
    frames = h.make_frames(seed, FRAMES_PER_STREAM)
    data, truth, sig_damaged, counts = h.corrupted_stream(frames, seed + 100)
    mf_keys, counters = h.run_mavframe(data)
    py_keys, spans, consumed = h.run_pymavlink(data)
    res = h.compare(truth, sig_damaged, mf_keys, py_keys, spans, consumed)

    assert counts["bitflip"] > 100 and counts["cut"] > 100 and counts["garbage_runs"] > 100
    assert counters["bytes"] == len(data)
    for name, value in res.items():
        if name.endswith("_unexplained"):
            assert value == [], name
    # Neither parser reports a frame that was not written to the stream.
    assert res["mavframe_decoded"] == res["mavframe_matched"] + res["mavframe_signature_cut_accepted"]
    assert res["pymavlink_decoded"] == res["pymavlink_matched"] + res["pymavlink_signature_cut_accepted"]
    # Every intact frame is found by mavframe unless a signature-cut frame in front swallowed its start.
    assert res["mavframe_matched"] + res["mavframe_missed_inside_accepted_signed_frame"] == res["expected"]
    # The streams must really exercise the resync difference.
    assert res["only_mavframe_inside_span_pymavlink_discarded"] > 100
    assert not res["sequence_identical"]


def test_unknown_message_id_is_not_reported_as_frame():
    # Message id 3 does not exist in the common dialect. pymavlink returns an
    # UNKNOWN_3 object without checking any CRC; mavframe counts it separately.
    frame = bytes([0xFD, 2, 0, 0, 0, 1, 1, 3, 0, 0, 0xAA, 0xBB, 0x12, 0x34])
    good, truth = h.clean_stream(h.make_frames(11, 3))
    mf_keys, counters = h.run_mavframe(frame + good)
    py_keys, spans, _ = h.run_pymavlink(frame + good)
    assert counters["unknown_msgid"] == 1 and counters["frames"] == 3
    assert spans[0] == (0, len(frame), "unknown")
    shifted = [(k[0] + len(frame),) + k[1:] for k in truth]
    assert mf_keys == shifted == py_keys
