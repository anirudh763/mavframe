"""Shared code for the differential tests: stream generation, running both
parsers on the same bytes, and classifying every difference.

A decoded frame is compared as the tuple
    (stream offset, msgid, sysid, compid, seq, signed, payload hex).
"""
import os
import random
import struct
import subprocess

from pymavlink.dialects.v20 import common as mav

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DUMP = os.environ.get("MAVFRAME_DUMP", os.path.join(ROOT, "build", "mavframe-dump"))

INT_RANGES = {
    "uint8_t": (0, 2**8 - 1), "int8_t": (-(2**7), 2**7 - 1),
    "uint16_t": (0, 2**16 - 1), "int16_t": (-(2**15), 2**15 - 1),
    "uint32_t": (0, 2**32 - 1), "int32_t": (-(2**31), 2**31 - 1),
    "uint64_t": (0, 2**64 - 1), "int64_t": (-(2**63), 2**63 - 1),
}


def _random_scalar(rng, ftype):
    if ftype in INT_RANGES:
        lo, hi = INT_RANGES[ftype]
        # Small values are common in real telemetry and exercise v2 zero trimming.
        return rng.choice([0, rng.randint(0, 3), rng.randint(lo, hi)])
    # float / double: a value that survives a 32-bit round trip
    return struct.unpack("<f", struct.pack("<f", rng.uniform(-1e6, 1e6)))[0]


def random_message(rng, cls):
    """Build one message object of class cls with random field values."""
    args = []
    # fieldtypes follows fieldnames; array_lengths follows the wire order.
    alens = dict(zip(cls.ordered_fieldnames, cls.array_lengths))
    for name, ftype in zip(cls.fieldnames, cls.fieldtypes):
        alen = alens[name]
        if ftype == "char":
            n = rng.randint(0, max(alen, 1))
            args.append("".join(rng.choice("abcdefXYZ 0123") for _ in range(n)).encode())
        elif alen:
            args.append([_random_scalar(rng, ftype) for _ in range(alen)])
        else:
            args.append(_random_scalar(rng, ftype))
    return cls(*args)


def make_frames(seed, count):
    """count random valid v2 frames (bytes) across all message types of the
    common dialect. About 1 in 20 is signed."""
    rng = random.Random(seed)
    classes = [mav.mavlink_map[k] for k in sorted(mav.mavlink_map)]
    plain = mav.MAVLink(None)
    signer = mav.MAVLink(None)
    signer.signing.secret_key = bytes(range(32))
    signer.signing.sign_outgoing = True
    signer.signing.timestamp = 1000
    frames = []
    for _ in range(count):
        link = signer if rng.random() < 0.05 else plain
        link.srcSystem = rng.randint(1, 255)
        link.srcComponent = rng.randint(0, 255)
        link.seq = rng.randint(0, 255)
        frames.append(bytes(random_message(rng, rng.choice(classes)).pack(link)))
    return frames


def frame_key(offset, raw):
    """Comparison tuple for a raw v2 frame at a stream offset."""
    plen = raw[1]
    return (offset, raw[7] | raw[8] << 8 | raw[9] << 16, raw[5], raw[6], raw[4],
            raw[2] & 1, bytes(raw[10:10 + plen]).hex())


def clean_stream(frames):
    """Concatenate frames. Returns (bytes, list of expected frame keys)."""
    out, truth = bytearray(), []
    for f in frames:
        truth.append(frame_key(len(out), f))
        out += f
    return bytes(out), truth


def corrupted_stream(frames, seed):
    """Interleave frames with damage. Returns (bytes, truth, sig_damaged, counts).
    truth holds the keys of the frames that were written unmodified.
    sig_damaged holds the keys of signed frames whose header, payload and CRC
    were written intact but whose 13-byte signature was cut: a parser that
    does not verify signatures must still report these, and will take the
    missing signature bytes from whatever follows.

    Per frame: 70% intact, 10% one bit flipped (outside the signature, which
    neither parser checks), 10% cut short at a random point, 10% a random
    middle part removed. Before 15% of the frames, 1..300 random bytes."""
    rng = random.Random(seed)
    out, truth, sig_damaged = bytearray(), [], []
    counts = {"intact": 0, "signature_cut": 0, "bitflip": 0, "cut": 0, "hole": 0, "garbage_runs": 0, "garbage_bytes": 0}
    for f in frames:
        if rng.random() < 0.15:
            n = rng.randint(1, 300)
            out += bytes(rng.getrandbits(8) for _ in range(n))
            counts["garbage_runs"] += 1
            counts["garbage_bytes"] += n
        r = rng.random()
        if r < 0.70:
            truth.append(frame_key(len(out), f))
            out += f
            counts["intact"] += 1
        elif r < 0.80:
            unsigned_len = 10 + f[1] + 2
            bit = rng.randrange(unsigned_len * 8)
            g = bytearray(f)
            g[bit // 8] ^= 1 << (bit % 8)
            out += g
            counts["bitflip"] += 1
        else:
            if r < 0.90:
                a, b, kind = rng.randrange(1, len(f)), len(f), "cut"
            else:
                a = rng.randrange(1, len(f) - 1)
                b, kind = rng.randrange(a + 1, len(f)), "hole"
            if a >= 10 + f[1] + 2:
                sig_damaged.append(frame_key(len(out), f))
                kind = "signature_cut"
            out += f[:a] + f[b:]
            counts[kind] += 1
    return bytes(out), truth, sig_damaged, counts


def run_mavframe(data):
    """Run mavframe-dump on data. Returns (frame keys, counters dict)."""
    proc = subprocess.run([DUMP], input=data, capture_output=True, check=True)
    keys = []
    for line in proc.stdout.decode().splitlines():
        kv = dict(item.split("=", 1) for item in line.split())
        keys.append((int(kv["off"]), int(kv["msgid"]), int(kv["sysid"]), int(kv["compid"]),
                     int(kv["seq"]), int(kv["signed"]), kv["payload"]))
    counters = {k: int(v) for k, v in (item.split("=") for item in proc.stderr.decode().split())}
    return keys, counters


def run_pymavlink(data, chunk=4096):
    """Run pymavlink's parser (robust_parsing=True) on data.

    Returns (frame keys, spans, consumed) where spans lists
    (offset, length, kind) for every piece pymavlink returned; kind is
    'frame', 'v1' (a MAVLink v1 frame, which mavframe does not parse),
    'unknown' (unknown message id, returned without a CRC check) or 'bad'.
    consumed is how many bytes it had released at end of input."""
    parser = mav.MAVLink(None)
    parser.robust_parsing = True
    keys, spans, offset = [], [], 0
    for i in range(0, len(data), chunk):
        for m in parser.parse_buffer(data[i:i + chunk]) or []:
            raw = bytes(m.get_msgbuf())
            if m.get_type() == "BAD_DATA":
                kind = "bad"
            elif m.get_type().startswith("UNKNOWN"):
                kind = "unknown"
            elif raw[0] == 0xFE:
                kind = "v1"
            else:
                kind = "frame"
                keys.append(frame_key(offset, raw))
            spans.append((offset, len(raw), kind))
            offset += len(raw)
    return keys, spans, offset


def _inside_accepted(key, accepted_keys):
    """True if the frame starts strictly inside the byte range that a parser
    took for a frame it accepted (payload hex gives the length)."""
    off = key[0]
    for k in accepted_keys:
        length = 12 + len(k[6]) // 2 + 13 * k[5]
        if k[0] < off < k[0] + length:
            return True
    return False


def compare(truth, sig_damaged, mf_keys, py_keys, py_spans, py_consumed):
    """Classify every difference between ground truth and the two parsers.

    Each list in the result whose name ends in _unexplained must be empty."""
    truth_set, expected_extra = set(truth), set(sig_damaged)
    mf, py = set(mf_keys), set(py_keys)
    discarded = [(o, n) for o, n, kind in py_spans if kind != "frame" and n > 1]
    res = {
        "expected": len(truth),
        "mavframe_decoded": len(mf_keys),
        "mavframe_matched": len(truth_set & mf),
        "pymavlink_decoded": len(py_keys),
        "pymavlink_matched": len(truth_set & py),
        "both": len(mf & py),
        "pymavlink_v1_decodes": sum(1 for s in py_spans if s[2] == "v1"),
        "sequence_identical": mf_keys == py_keys,
    }
    for name, got in (("mavframe", mf), ("pymavlink", py)):
        # Decoded but not written intact: only signature-cut frames are legitimate.
        extra = got - truth_set
        res[name + "_signature_cut_accepted"] = len(extra & expected_extra)
        res[name + "_false_unexplained"] = sorted(extra - expected_extra)
    # Intact frames mavframe did not report.
    missed = truth_set - mf
    swallowed = {k for k in missed if _inside_accepted(k, mf)}
    res["mavframe_missed"] = len(missed)
    res["mavframe_missed_inside_accepted_signed_frame"] = len(swallowed)
    res["mavframe_missed_unexplained"] = sorted(missed - swallowed)
    # Frames only one parser reported.
    only_py = py - mf
    res["only_pymavlink"] = len(only_py)
    res["only_pymavlink_unexplained"] = sorted(k for k in only_py if not _inside_accepted(k, mf))
    only_mf = mf - py
    inside = {k for k in only_mf if any(o < k[0] < o + n for o, n in discarded)}
    at_start = {k for k in only_mf - inside if any(o == k[0] for o, n in discarded)}
    stalled = {k for k in only_mf - inside - at_start if k[0] >= py_consumed}
    swallowed = {k for k in only_mf - inside - at_start - stalled if _inside_accepted(k, py)}
    res["only_mavframe"] = len(only_mf)
    res["only_mavframe_inside_span_pymavlink_discarded"] = len(inside)
    res["only_mavframe_pymavlink_stalled_at_eof"] = len(stalled)
    res["only_mavframe_inside_pymavlink_accepted_signed_frame"] = len(swallowed)
    res["only_mavframe_unexplained"] = sorted(only_mf - inside - at_start - stalled - swallowed)
    res["only_mavframe_at_start_of_discarded_span_unexplained"] = sorted(at_start)
    return res
