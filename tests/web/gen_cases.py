#!/usr/bin/env python3
"""Write deterministic test streams for tests/web/ into a directory.

    python3 tests/web/gen_cases.py OUTDIR

  signed.bin     20 frames, every one signed by pymavlink (common dialect),
                 followed by a signed frame whose signature is cut short and
                 a signed frame with a flipped payload bit (CRC error)
  malformed.bin  one case after another: valid frame, bit flip, frame cut
                 short, middle removed, unknown message id, unsupported
                 incompat flags, MAVLink v1 frame, random bytes, valid frame
  boundary.bin   short stream (valid, signed, bad CRC, unknown id, bad flags,
                 garbage, valid) for splitting at every byte boundary
  signed.tlog    the 20 signed frames as .tlog records (for the browser test)
  corrupt-ts.tlog  2,000 .tlog records; every 10th frame has a payload byte
                 changed (CRC error), and timestamps are chosen so that many
                 hold a 0xFD byte that looks like a frame start (before valid
                 and before corrupted frames). Expected: exactly 200 CRC
                 errors, no other issues. Counts in corrupt-ts.json.
  seq-*.bin      HEARTBEATs from one component with chosen sequence numbers
                 (see SEQ_CASES) for the sequence classification tests
"""
import os
import random
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import harness  # noqa: E402  (tests/harness.py)
from pymavlink.dialects.v10 import common as mav1  # noqa: E402
from pymavlink.dialects.v20 import common as mav  # noqa: E402


def link(signed, sysid=1, compid=1):
    m = mav.MAVLink(None, srcSystem=sysid, srcComponent=compid)
    if signed:
        m.signing.secret_key = bytes(range(32))
        m.signing.sign_outgoing = True
        m.signing.timestamp = 1000
    return m


def pack(msg, lk):
    b = bytes(msg.pack(lk))
    lk.seq = (lk.seq + 1) % 256
    return b


SEQ_CASES = {
    "in-order": [10, 11],
    "duplicate": [10, 10, 11],
    "backwards": [10, 9, 11],
    "wrap": [255, 0],
    "gap": [10, 13],
    "reset": [200, 150, 151],
}


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    rng = random.Random(77)
    classes = [mav.mavlink_map[k] for k in sorted(mav.mavlink_map)]

    signer = link(True, 7, 1)
    signed = [pack(harness.random_message(rng, rng.choice(classes)), signer) for _ in range(20)]
    assert all(f[2] & 1 and len(f) == 12 + f[1] + 13 for f in signed)
    cut = pack(mav.MAVLink_heartbeat_message(2, 12, 129, 0, 4, 3), signer)[:-5]
    flipped = bytearray(pack(mav.MAVLink_attitude_message(1, 0.1, 0.2, 0.3, 0, 0, 0), signer))
    flipped[12] ^= 0x10
    with open(os.path.join(out, "signed.bin"), "wb") as f:
        f.write(b"".join(signed) + cut + bytes(flipped))
    with open(os.path.join(out, "signed.tlog"), "wb") as f:
        for i, fr in enumerate(signed):
            f.write(struct.pack(">Q", 1767225600000000 + i * 100000) + fr)

    plain = link(False)
    frames = [pack(harness.random_message(rng, rng.choice(classes)), plain) for _ in range(8)]
    hb = pack(mav.MAVLink_heartbeat_message(2, 12, 129, 0, 4, 3), plain)
    bitflip = bytearray(frames[1])
    bitflip[10] ^= 0x01
    unknown = bytes([0xFD, 2, 0, 0, 5, 1, 1, 3, 0, 0, 0xAA, 0xBB, 0x12, 0x34])  # id 3 is not in common
    badflags = bytearray(hb)
    badflags[2] = 0x02
    v1 = bytes(mav1.MAVLink_heartbeat_message(6, 8, 0, 0, 4, 3).pack(mav1.MAVLink(None, 2, 191)))
    noise = bytes(rng.getrandbits(8) for _ in range(64))
    malformed = (frames[0] + bytes(bitflip) + frames[2][:9] + frames[3][:5] + frames[3][11:] + unknown
                 + bytes(badflags) + v1 + noise + frames[4] + hb)
    with open(os.path.join(out, "malformed.bin"), "wb") as f:
        f.write(malformed)

    for name, seqs in SEQ_CASES.items():
        lk = link(False, 3, 1)
        out_frames = []
        for q in seqs:
            lk.seq = q
            out_frames.append(bytes(mav.MAVLink_heartbeat_message(2, 12, 129, 0, 4, 3).pack(lk)))
        with open(os.path.join(out, "seq-%s.bin" % name), "wb") as f:
            f.write(b"".join(out_frames))

    # .tlog with corrupted frames and 0xFD bytes inside timestamps.
    lk = link(False, 1, 1)
    recs, crc = bytearray(), 0
    for i in range(2000):
        if i % 2:
            msg = mav.MAVLink_attitude_message(i, 0.1, 0.2, 0.3, 0.01, 0.02, 0.03)
        else:
            msg = mav.MAVLink_vfr_hud_message(12.5, 12.0, 90, 55, 50.0, 0.5)
        fr = bytearray(pack(msg, lk))
        if i % 10 == 3:
            fr[12] ^= 0x40
            crc += 1
        ts = bytearray(struct.pack(">Q", 1767225600000000 + i * 20000))
        if i % 4 == 0:
            ts[6] = 0xFD                 # fake header whose flags byte is the real 0xFD: bad flags
        elif i % 4 == 1:
            ts[5], ts[7] = 0xFD, 0x00    # fake header with msgid = seq | sys<<8 | comp<<16: unknown id
        elif i % 4 == 2:
            ts[7] = 0xFD                 # fake header whose length byte is the real 0xFD
        recs += ts + fr
    with open(os.path.join(out, "corrupt-ts.tlog"), "wb") as f:
        f.write(recs)
    with open(os.path.join(out, "corrupt-ts.json"), "w", encoding="utf-8") as f:
        f.write('{"records": 2000, "crc_errors": %d, "frames": %d}\n' % (crc, 2000 - crc))

    boundary = (hb + signed[0] + bytes(flipped) + unknown + bytes(badflags) + noise[:9] + frames[5])
    with open(os.path.join(out, "boundary.bin"), "wb") as f:
        f.write(boundary)


if __name__ == "__main__":
    main()
