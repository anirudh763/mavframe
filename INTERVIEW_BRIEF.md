# Interview brief: mavframe

## What it does, in three sentences

mavframe takes a stream of bytes from a drone telemetry link and finds the
MAVLink v2 frames in it: it checks the start byte, the header, and the 16-bit
CRC (which includes a per-message constant called CRC_EXTRA), and hands back
the message id, sender ids, sequence number and payload bytes. It uses one
fixed 280-byte buffer and no malloc, and when a frame turns out to be bad it
re-examines the bytes it already holds, so a good frame that begins inside a
bad one is still found. It was checked against pymavlink on 20,000 generated
frames, fuzzed with libFuzzer, benchmarked, and compiled for a Cortex-M3.

## How the data flows, file by file

1. `tools/gen_crc_extra.py` reads pymavlink's `common` dialect and writes
   `src/mavframe_crc_extra_common.h`: a sorted array of `(msgid << 8) | crc_extra`.
2. `include/mavframe.h` defines the parser struct (`buf`, `head`, `tail`,
   `consume`, `need`, `stats`), the status enum, and inline accessors that read
   fields straight out of `buf + head`.
3. `src/mavframe.c`:
   - `mavframe_feed()` copies input bytes to `buf[tail]`. It copies only as
     many as the current candidate needs (`need`): 10 for the header, then the
     full frame length. With an empty buffer it lets in nothing but 0xFD.
   - `step()` looks at `buf[head..tail)` and returns one event. In order: not
     0xFD -> drop; fewer than 10 bytes -> need more; unknown incompat flag ->
     fail; msgid not in table (`mavframe_crc_extra`, binary search) -> fail;
     not all bytes there -> need more; CRC (`mavframe_crc16`) wrong -> fail;
     else frame.
   - `fail()` sets `consume` to the distance to the next 0xFD in the buffer.
     Nothing is moved yet. The next `step()` call advances `head` by `consume`
     and examines what is left. That is the resync.
   - `consume` is applied lazily so that after a FRAME event the accessors
     still point at the frame until the next call.
   - `mavframe_feed_byte()` is `mavframe_feed()` with one byte;
     `mavframe_poll()` is `step()`; `mavframe_flush()` fails an unfinished
     candidate at end of stream.
4. `tools/mavframe-dump.c` reads stdin in 64 kB chunks, calls `mavframe_feed`,
   prints one line per frame and the counters to stderr.
5. `tests/test_mavframe.c` builds frames by hand and checks events.
   `tests/harness.py` generates streams with pymavlink, runs both parsers and
   classifies differences; `tests/test_differential.py` asserts on that;
   `tests/report.py` prints the README numbers.
6. `fuzz/fuzz_parse.c` runs the parser twice (byte-wise and chunked) on fuzzer
   input and checks invariants. `bench/bench.c` times parsing of a file.

## Three hard questions, with honest answers

**1. "Your table says pymavlink only recovered 6,905 of 10,542 frames. Are you
claiming your parser is better than the reference implementation?"**

No. On clean input they agree on all 5,000 frames. The gap comes from one
policy difference on damaged input: when a candidate frame fails, pymavlink
skips the whole length that the (possibly corrupted) header announced, and
mavframe skips only to the next 0xFD. My test streams damage 30% of frames and
add garbage, which is far worse than a normal link, so the gap is exaggerated
on purpose to exercise resync. pymavlink also does much more: v1, field
decoding, signature verification. And my approach has costs: 280 bytes of RAM
per parser and a worst case that is about 19 times slower (14.4 vs 272.4 MB/s).

**2. "What did the fuzzer find, and why did your own tests miss it?"**

After reporting a valid frame that was found during a rescan, the parser
assumed the next buffered byte was 0xFD. The CRC does not cover the start
byte, so a byte sequence with a wrong start byte but a matching CRC was
reported as a frame. My unit tests always put a real frame or nothing after a
hidden frame, and random damage in the differential test almost never
produces bytes with a matching CRC behind a wrong start byte. The fuzz target caught it because it asserts that
every reported frame starts with 0xFD, and coverage feedback found a CRC match.
The fix is a two-line check in `step()`, with a regression test that fails
without it. The lesson I took: I had an invariant in my head ("buf[head] is
always 0xFD") that the code did not enforce everywhere.

**3. "A signed frame arrives with a damaged signature. What happens?"**

The frame is accepted, because the CRC covers header and payload only and I do
not verify the signature (that needs SHA-256 and a shared key). If the
signature was cut short, the parser takes the next bytes of the stream as the
rest of the signature and can swallow the start of the following frame. I
measured this: 21 of 10,542 intact frames lost in the corrupted streams, all
explained by this case. So this parser must not be used as an authentication
check; it is stated in the README limitations.

Other things worth knowing cold: the CRC is CRC-16/MCRF4XX (init 0xFFFF,
reflected polynomial 0x8408, no final XOR), check value 0x6F91 for
"123456789"; CRC_EXTRA exists so that two sides with different message
definitions fail the CRC instead of misreading fields; the largest frame is
10 + 255 + 2 + 13 = 280 bytes.

## One small change to make yourself

Add a counter `flushed` to `mavframe_stats` that counts how many unfinished
candidates `mavframe_flush()` gave up on. You will need to touch the struct in
`include/mavframe.h`, the `fail()` function in `src/mavframe.c` (it already
receives `MAVFRAME_DROPPED` from two different callers, so decide how to tell
them apart), the summary line in `tools/mavframe-dump.c`, and the counter
parsing in `tests/harness.py` plus the exact-dictionary assertion in
`test_clean_stream_sequences_identical`. Then add a C test next to
`test_flush_releases_hidden_frame`. It is about 15 lines and makes you read
the lazy-consume logic.
