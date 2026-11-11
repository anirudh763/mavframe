#!/usr/bin/env python3
"""Print the differential-test numbers quoted in the README.

    python3 tests/report.py
"""
import harness as h
from test_differential import CLEAN_SEED, CORRUPT_SEEDS, FRAMES_PER_STREAM


def main():
    data, truth = h.clean_stream(h.make_frames(CLEAN_SEED, FRAMES_PER_STREAM))
    mf, _ = h.run_mavframe(data)
    py, _, _ = h.run_pymavlink(data)
    print("clean seed=%d: bytes=%d expected=%d mavframe=%d pymavlink=%d sequences_identical=%s"
          % (CLEAN_SEED, len(data), len(truth), len(mf), len(py), mf == py == truth))
    for seed in CORRUPT_SEEDS:
        frames = h.make_frames(seed, FRAMES_PER_STREAM)
        data, truth, sig, counts = h.corrupted_stream(frames, seed + 100)
        mf, counters = h.run_mavframe(data)
        py, spans, consumed = h.run_pymavlink(data)
        res = h.compare(truth, sig, mf, py, spans, consumed)
        print("corrupted seed=%d: bytes=%d" % (seed, len(data)))
        print("  written:", " ".join("%s=%d" % kv for kv in counts.items()))
        print("  mavframe counters:", " ".join("%s=%d" % kv for kv in counters.items()))
        for name, value in res.items():
            print("  %s=%s" % (name, len(value) if isinstance(value, list) else value))


if __name__ == "__main__":
    main()
