#!/usr/bin/env python3
"""Write a benchmark stream built by the test generator.

    python3 bench/gen_stream.py clean   50000 out.bin   # valid frames only
    python3 bench/gen_stream.py corrupt 50000 out.bin   # with damage, see tests/harness.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests"))
import harness  # noqa: E402

SEED = 42


def main():
    kind, count, path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    frames = harness.make_frames(SEED, count)
    if kind == "clean":
        data = harness.clean_stream(frames)[0]
    else:
        data = harness.corrupted_stream(frames, SEED + 100)[0]
    with open(path, "wb") as f:
        f.write(data)
    print("%s: %d bytes from %d generated frames" % (path, len(data), count))


if __name__ == "__main__":
    main()
