#!/usr/bin/env python3
"""Independent corrupted .tlog from the adversarial review (seed 9001).

    python3 tests/web/gen_critic_tlog.py OUT.tlog     # also writes OUT.json

20,000 frames from 3 senders (1:1, 1:191, 42:7), random message types of the
common dialect (pymavlink), 200 of them corrupted by XOR of a random byte in
payload or CRC, random timestamp steps, and 0xFD forced into a random
timestamp byte (positions 4..7) of about 15% of the records. The JSON gives
the expected counts: valid frames, CRC errors, and sequence gaps (one per run
of corrupted frames from a sender, unless the run is at the end).
Called by tests/web/gen_cases.py; written by the reviewer, kept as-is apart
from the command line and this docstring.
"""
import json
import os
import random
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import harness  # noqa: E402  (tests/harness.py)
from pymavlink.dialects.v20 import common as mav  # noqa: E402


def main(path):
    rng = random.Random(9001)
    classes = [mav.mavlink_map[k] for k in sorted(mav.mavlink_map)]
    links = {s: mav.MAVLink(None, srcSystem=s[0], srcComponent=s[1]) for s in [(1, 1), (1, 191), (42, 7)]}
    n = 20000
    corrupt_idx = set(rng.sample(range(n), 200))
    out = bytearray()
    t = 1767225600123457
    gaps_expected = 0
    prev_lost = {s: False for s in links}
    for i in range(n):
        s = rng.choice(list(links))
        lk = links[s]
        fr = bytearray(harness.random_message(rng, rng.choice(classes)).pack(lk))
        lk.seq = (lk.seq + 1) % 256
        if i in corrupt_idx:
            p = rng.randrange(10, len(fr))
            fr[p] ^= rng.randrange(1, 256)
            if not prev_lost[s]:
                gaps_expected += 1
            prev_lost[s] = True
        else:
            prev_lost[s] = False
        t += rng.randrange(500, 30000)
        ts = bytearray(struct.pack(">Q", t))
        if rng.random() < 0.15:
            ts[rng.randrange(4, 8)] = 0xFD
        out += ts + fr
    for s in links:  # a run of lost frames at the very end produces no gap
        if prev_lost[s]:
            gaps_expected -= 1
    with open(path, "wb") as f:
        f.write(out)
    with open(os.path.splitext(path)[0] + ".json", "w", encoding="utf-8") as f:
        json.dump({"frames": n - 200, "crc": 200, "gaps_expected": gaps_expected, "seed": 9001}, f)


if __name__ == "__main__":
    main(sys.argv[1])
