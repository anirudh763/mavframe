/* Unit tests for mavframe. No framework: CHECK() counts failures, main returns non-zero on any. */
#include <stdio.h>
#include <string.h>

#include "mavframe.h"

static int failures;
static int checks;

#define CHECK(cond)                                                        \
    do {                                                                   \
        checks++;                                                          \
        if (!(cond)) {                                                     \
            failures++;                                                    \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);         \
        }                                                                  \
    } while (0)

#define MSG_HEARTBEAT 0u     /* CRC_EXTRA 50 */
#define MSG_ATTITUDE 30u     /* CRC_EXTRA 39 */
#define MSG_UNKNOWN 3u       /* not in the common dialect table */

/* Build a v2 frame into out (at least MAVFRAME_MAX_FRAME bytes). Returns its length. */
static size_t build(uint8_t *out, uint32_t msgid, uint8_t seq, const uint8_t *payload, uint8_t len,
                    int with_signature)
{
    uint8_t extra = 0;
    uint16_t crc;
    size_t n = MAVFRAME_HEADER_LEN;

    out[0] = MAVFRAME_STX;
    out[1] = len;
    out[2] = with_signature ? MAVFRAME_IFLAG_SIGNED : 0;
    out[3] = 0;
    out[4] = seq;
    out[5] = 42;
    out[6] = 7;
    out[7] = (uint8_t)(msgid & 0xFF);
    out[8] = (uint8_t)((msgid >> 8) & 0xFF);
    out[9] = (uint8_t)((msgid >> 16) & 0xFF);
    if (len)
        memcpy(out + n, payload, len);
    n += len;
    (void)mavframe_crc_extra(msgid, &extra);
    crc = mavframe_crc16(MAVFRAME_CRC_INIT, out + 1, n - 1);
    crc = mavframe_crc16(crc, &extra, 1);
    out[n++] = (uint8_t)(crc & 0xFF);
    out[n++] = (uint8_t)(crc >> 8);
    if (with_signature) {
        int i;
        for (i = 0; i < MAVFRAME_SIGNATURE_LEN; i++)
            out[n++] = (uint8_t)(0xA0 + i);
    }
    return n;
}

/* A recorded event: status plus, for frames, the fields we compare. */
typedef struct {
    mavframe_status st;
    uint32_t msgid;
    uint8_t seq, len;
    uint16_t payload_sum;
} event;

#define MAX_EVENTS 16384

static void record(event *ev, size_t *n, const mavframe_parser *p, mavframe_status st)
{
    event e;
    memset(&e, 0, sizeof(e));
    e.st = st;
    if (st == MAVFRAME_FRAME) {
        unsigned i;
        e.msgid = mavframe_msgid(p);
        e.seq = mavframe_seq(p);
        e.len = mavframe_payload_len(p);
        for (i = 0; i < e.len; i++)
            e.payload_sum = (uint16_t)(e.payload_sum * 31u + mavframe_payload(p)[i]);
    }
    if (*n < MAX_EVENTS)
        ev[(*n)++] = e;
}

/* Feed a whole stream one byte at a time; record all events including flush. */
static size_t run_bytes(mavframe_parser *p, const uint8_t *data, size_t len, event *ev, int flush)
{
    size_t n = 0, i;
    mavframe_status st;

    mavframe_init(p);
    for (i = 0; i < len; i++) {
        st = mavframe_feed_byte(p, data[i]);
        while (st != MAVFRAME_NEED_MORE) {
            record(ev, &n, p, st);
            st = mavframe_poll(p);
        }
    }
    while (flush && (st = mavframe_flush(p)) != MAVFRAME_NEED_MORE)
        record(ev, &n, p, st);
    return n;
}

/* Same, but through mavframe_feed() in chunks of the given size. */
static size_t run_chunks(mavframe_parser *p, const uint8_t *data, size_t len, size_t chunk,
                         event *ev, int flush)
{
    size_t n = 0, base = 0;
    mavframe_status st;

    mavframe_init(p);
    while (base < len) {
        size_t this_chunk = len - base < chunk ? len - base : chunk;
        size_t off = 0;
        while (off < this_chunk) {
            off += mavframe_feed(p, data + base + off, this_chunk - off, &st);
            if (st != MAVFRAME_NEED_MORE)
                record(ev, &n, p, st);
        }
        base += this_chunk;
    }
    while (flush && (st = mavframe_flush(p)) != MAVFRAME_NEED_MORE)
        record(ev, &n, p, st);
    return n;
}

static size_t count(const event *ev, size_t n, mavframe_status st)
{
    size_t i, c = 0;
    for (i = 0; i < n; i++)
        c += ev[i].st == st;
    return c;
}

/* Keep only the frame events, in order. Returns how many. */
static size_t frames_only(event *ev, size_t n)
{
    size_t i, k = 0;
    for (i = 0; i < n; i++)
        if (ev[i].st == MAVFRAME_FRAME)
            ev[k++] = ev[i];
    return k;
}

static event ev[MAX_EVENTS], ev2[MAX_EVENTS];
static mavframe_parser p;

static void test_crc_known_answer(void)
{
    /* CRC-16/MCRF4XX check value for the ASCII string "123456789". */
    CHECK(mavframe_crc16(MAVFRAME_CRC_INIT, (const uint8_t *)"123456789", 9) == 0x6F91);
    CHECK(mavframe_crc16(MAVFRAME_CRC_INIT, NULL, 0) == 0xFFFF);
}

static void test_crc_extra_table(void)
{
    uint8_t extra = 0;
    CHECK(mavframe_crc_extra(MSG_HEARTBEAT, &extra) && extra == 50);
    CHECK(mavframe_crc_extra(MSG_ATTITUDE, &extra) && extra == 39);
    CHECK(!mavframe_crc_extra(MSG_UNKNOWN, &extra));
    CHECK(!mavframe_crc_extra(0xFFFFFFu, &extra));
}

static void test_heartbeat_fields(void)
{
    /* A real HEARTBEAT frame as produced by pymavlink (sysid 1, compid 1, seq 0). */
    static const uint8_t hb[] = {0xFD, 0x09, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
                                 0x00, 0x00, 0x00, 0x02, 0x03, 0x51, 0x04, 0x03, 0xE7, 0x1E};
    size_t i;
    mavframe_status st = MAVFRAME_NEED_MORE;

    mavframe_init(&p);
    for (i = 0; i < sizeof(hb); i++) {
        CHECK(st == MAVFRAME_NEED_MORE);
        st = mavframe_feed_byte(&p, hb[i]);
    }
    CHECK(st == MAVFRAME_FRAME);
    CHECK(mavframe_msgid(&p) == MSG_HEARTBEAT);
    CHECK(mavframe_sysid(&p) == 1 && mavframe_compid(&p) == 1 && mavframe_seq(&p) == 0);
    CHECK(mavframe_incompat_flags(&p) == 0 && mavframe_compat_flags(&p) == 0);
    CHECK(mavframe_payload_len(&p) == 9);
    CHECK(memcmp(mavframe_payload(&p), hb + 10, 9) == 0);
    CHECK(!mavframe_signed(&p) && mavframe_signature(&p) == NULL);
    CHECK(mavframe_frame_len(&p) == sizeof(hb));
    CHECK(mavframe_poll(&p) == MAVFRAME_NEED_MORE);
    CHECK(mavframe_pending(&p) == 0);
}

static void test_zero_length_payload(void)
{
    uint8_t f[MAVFRAME_MAX_FRAME];
    size_t len = build(f, MSG_HEARTBEAT, 1, NULL, 0, 0);
    size_t n = run_bytes(&p, f, len, ev, 0);

    CHECK(len == 12);
    CHECK(n == 1 && ev[0].st == MAVFRAME_FRAME && ev[0].len == 0);
}

static void test_max_payload(void)
{
    uint8_t f[MAVFRAME_MAX_FRAME], payload[255];
    size_t len, n, i;

    for (i = 0; i < sizeof(payload); i++)
        payload[i] = (uint8_t)(i * 7 + 1);
    payload[100] = MAVFRAME_STX; /* a start byte inside the payload is just data */
    len = build(f, MSG_ATTITUDE, 2, payload, 255, 0);
    CHECK(len == 267);
    mavframe_init(&p);
    for (i = 0; i + 1 < len; i++)
        CHECK(mavframe_feed_byte(&p, f[i]) == MAVFRAME_NEED_MORE);
    CHECK(mavframe_feed_byte(&p, f[len - 1]) == MAVFRAME_FRAME);
    CHECK(mavframe_payload_len(&p) == 255);
    CHECK(memcmp(mavframe_payload(&p), payload, 255) == 0);
    n = run_bytes(&p, f, len, ev, 0);
    CHECK(n == 1);
}

static void test_v2_trimmed_payload(void)
{
    /* MAVLink v2 senders drop trailing zero bytes of the payload. The parser
     * must accept the shorter length as it is. HEARTBEAT is 9 bytes untrimmed. */
    static const uint8_t payload[3] = {1, 2, 3};
    uint8_t f[MAVFRAME_MAX_FRAME];
    size_t len = build(f, MSG_HEARTBEAT, 3, payload, 3, 0);
    size_t n = run_bytes(&p, f, len, ev, 0);

    CHECK(n == 1 && ev[0].st == MAVFRAME_FRAME && ev[0].len == 3);
}

static void test_stream_cut_mid_payload(void)
{
    /* Frame A loses its last 20 bytes, then frame B follows intact. */
    uint8_t a[MAVFRAME_MAX_FRAME], b[MAVFRAME_MAX_FRAME], s[2 * MAVFRAME_MAX_FRAME], payload[60];
    size_t la, lb, n, i;

    for (i = 0; i < sizeof(payload); i++)
        payload[i] = (uint8_t)(i + 1);
    la = build(a, MSG_ATTITUDE, 10, payload, 60, 0);
    lb = build(b, MSG_HEARTBEAT, 11, payload, 9, 0);
    memcpy(s, a, la - 20);
    memcpy(s + la - 20, b, lb);

    /* B (21 bytes) supplies the 20 bytes A still waits for, so A fails its
     * CRC and B is then found by rescanning the buffered bytes. */
    n = run_bytes(&p, s, la - 20 + lb, ev, 0);
    CHECK(count(ev, n, MAVFRAME_FRAME) == 1 && count(ev, n, MAVFRAME_BAD_CRC) == 1);
    CHECK(ev[0].st == MAVFRAME_BAD_CRC && ev[1].st == MAVFRAME_FRAME && ev[1].seq == 11);
    CHECK(p.stats.frames == 1 && p.stats.dropped_bytes == la - 20);

    /* Only the cut frame, then end of stream: flush reports the loss. */
    n = run_bytes(&p, s, la - 20, ev, 1);
    CHECK(n == 1 && ev[0].st == MAVFRAME_DROPPED);
    CHECK(p.stats.dropped_bytes == la - 20 && mavframe_pending(&p) == 0);
}

static void test_flush_releases_hidden_frame(void)
{
    /* A cut frame that announces 255 bytes, followed by a short valid frame
     * and then end of stream. Only flush can release the valid frame. */
    uint8_t a[MAVFRAME_MAX_FRAME], b[MAVFRAME_MAX_FRAME], s[2 * MAVFRAME_MAX_FRAME], payload[255];
    size_t lb, n;

    memset(payload, 0x55, sizeof(payload));
    (void)build(a, MSG_ATTITUDE, 20, payload, 255, 0);
    lb = build(b, MSG_HEARTBEAT, 21, payload, 9, 0);
    memcpy(s, a, 30);
    memcpy(s + 30, b, lb);
    n = run_bytes(&p, s, 30 + lb, ev, 0);
    CHECK(n == 0);
    n = run_bytes(&p, s, 30 + lb, ev, 1);
    CHECK(n == 2 && ev[0].st == MAVFRAME_DROPPED && ev[1].st == MAVFRAME_FRAME && ev[1].seq == 21);
}

static void test_bad_crc(void)
{
    uint8_t f[MAVFRAME_MAX_FRAME], payload[9] = {9, 8, 7, 6, 5, 4, 3, 2, 1};
    size_t len = build(f, MSG_HEARTBEAT, 4, payload, 9, 0);
    size_t n, bit;

    /* Every single-bit error anywhere in the frame must be rejected. */
    for (bit = 8; bit < len * 8; bit++) {
        f[bit / 8] ^= (uint8_t)(1u << (bit % 8));
        n = run_bytes(&p, f, len, ev, 1);
        CHECK(count(ev, n, MAVFRAME_FRAME) == 0);
        CHECK(p.stats.dropped_bytes == len);
        f[bit / 8] ^= (uint8_t)(1u << (bit % 8));
    }
    f[12] ^= 0x10;
    n = run_bytes(&p, f, len, ev, 0);
    CHECK(n == 1 && ev[0].st == MAVFRAME_BAD_CRC && p.stats.bad_crc == 1);
}

static void test_resync_inside_corrupted_frame(void)
{
    /* Outer frame: a 200-byte payload that contains two complete valid
     * frames, and whose own CRC is then broken. A parser that skips the
     * announced length of a bad frame loses both inner frames. */
    uint8_t inner1[MAVFRAME_MAX_FRAME], inner2[MAVFRAME_MAX_FRAME], outer[MAVFRAME_MAX_FRAME];
    uint8_t after[MAVFRAME_MAX_FRAME], payload[200], small[30], s[2 * MAVFRAME_MAX_FRAME];
    uint8_t seqs[2] = {0, 0};
    mavframe_status st;
    size_t l1, l2, lo, la, n, i;

    for (i = 0; i < sizeof(small); i++)
        small[i] = (uint8_t)(0x30 + i);
    l1 = build(inner1, MSG_ATTITUDE, 101, small, 28, 0);
    l2 = build(inner2, MSG_HEARTBEAT, 102, small, 9, 0);
    memset(payload, 0x11, sizeof(payload));
    memcpy(payload + 50, inner1, l1);
    memcpy(payload + 120, inner2, l2);
    lo = build(outer, MSG_ATTITUDE, 100, payload, 200, 0);
    la = build(after, MSG_HEARTBEAT, 103, small, 9, 0);

    /* Intact: the outer frame is one frame, inner bytes are payload. */
    n = run_bytes(&p, outer, lo, ev, 1);
    CHECK(n == 1 && ev[0].st == MAVFRAME_FRAME && ev[0].seq == 100);

    outer[lo - 1] ^= 0xFF; /* break the outer CRC */
    memcpy(s, outer, lo);
    memcpy(s + lo, after, la);
    n = run_bytes(&p, s, lo + la, ev, 1);
    CHECK(ev[0].st == MAVFRAME_BAD_CRC);
    CHECK(count(ev, n, MAVFRAME_BAD_CRC) == 1);
    /* Other failure events may sit in between (a CRC byte that happens to be
     * 0xFD starts a short-lived candidate); the frames and their order are fixed. */
    n = frames_only(ev, n);
    CHECK(n == 3);
    CHECK(ev[0].seq == 101 && ev[0].len == 28);
    CHECK(ev[1].seq == 102 && ev[1].len == 9);
    CHECK(ev[2].seq == 103 && ev[2].len == 9);
    CHECK(p.stats.bytes == lo + la);
    CHECK(p.stats.dropped_bytes == lo - l1 - l2);

    /* Both inner frames come out of the single byte that completes the outer frame. */
    mavframe_init(&p);
    for (i = 0; i + 1 < lo; i++)
        CHECK(mavframe_feed_byte(&p, s[i]) == MAVFRAME_NEED_MORE);
    CHECK(mavframe_feed_byte(&p, s[lo - 1]) == MAVFRAME_BAD_CRC);
    n = 0;
    while ((st = mavframe_poll(&p)) != MAVFRAME_NEED_MORE)
        if (st == MAVFRAME_FRAME)
            seqs[n++ % 2] = mavframe_seq(&p);
    CHECK(n == 2 && seqs[0] == 101 && seqs[1] == 102);
}

static void test_bytes_after_rescanned_frame(void)
{
    /* Regression test for a bug found by the fuzzer. A broken outer frame
     * hides a valid inner frame that is directly followed by bytes which
     * look like a frame with a correct CRC but start with 0x00 instead of
     * 0xFD. After reporting the inner frame the parser used to treat the
     * next buffered byte as a frame start without checking it. */
    uint8_t inner[MAVFRAME_MAX_FRAME], fake[MAVFRAME_MAX_FRAME], outer[MAVFRAME_MAX_FRAME];
    uint8_t payload[200], small[9] = {1, 2, 3, 4, 5, 6, 7, 8, 9};
    size_t li, lf, lo, n;

    li = build(inner, MSG_HEARTBEAT, 201, small, 9, 0);
    lf = build(fake, MSG_HEARTBEAT, 202, small, 9, 0);
    fake[0] = 0x00;
    memset(payload, 0x11, sizeof(payload));
    memcpy(payload + 40, inner, li);
    memcpy(payload + 40 + li, fake, lf);
    lo = build(outer, MSG_ATTITUDE, 200, payload, 200, 0);
    outer[lo - 1] ^= 0xFF;
    n = run_bytes(&p, outer, lo, ev, 1);
    CHECK(p.stats.frames == 1);
    CHECK(p.stats.dropped_bytes == lo - li);
    n = frames_only(ev, n);
    CHECK(n == 1 && ev[0].seq == 201);
}

static void test_garbage_between_frames(void)
{
    static const uint8_t junk[] = {0x00, 0xFE, 0x12, 0xFD, 0x03, 0xFF, 0xFD, 0xFD, 0x7A};
    uint8_t f[MAVFRAME_MAX_FRAME], s[3 * MAVFRAME_MAX_FRAME], payload[9] = {0};
    size_t len = build(f, MSG_HEARTBEAT, 5, payload, 9, 0), n, total = 0;

    memcpy(s + total, junk, sizeof(junk)); total += sizeof(junk);
    memcpy(s + total, f, len);             total += len;
    memcpy(s + total, junk, sizeof(junk)); total += sizeof(junk);
    memcpy(s + total, f, len);             total += len;
    n = run_bytes(&p, s, total, ev, 1);
    CHECK(count(ev, n, MAVFRAME_FRAME) == 2);
    CHECK(p.stats.dropped_bytes == 2 * sizeof(junk));
    CHECK(p.stats.bytes == total);
}

static void test_signed_frame(void)
{
    uint8_t f[MAVFRAME_MAX_FRAME], g[MAVFRAME_MAX_FRAME], s[2 * MAVFRAME_MAX_FRAME];
    uint8_t payload[9] = {1, 1, 2, 3, 5, 8, 13, 21, 34};
    size_t len = build(f, MSG_HEARTBEAT, 6, payload, 9, 1);
    size_t lg = build(g, MSG_HEARTBEAT, 7, payload, 9, 0);
    size_t n, i;

    CHECK(len == 10 + 9 + 2 + 13);
    mavframe_init(&p);
    for (i = 0; i + 1 < len; i++)
        CHECK(mavframe_feed_byte(&p, f[i]) == MAVFRAME_NEED_MORE);
    CHECK(mavframe_feed_byte(&p, f[len - 1]) == MAVFRAME_FRAME);
    CHECK(mavframe_signed(&p));
    CHECK(mavframe_incompat_flags(&p) == MAVFRAME_IFLAG_SIGNED);
    CHECK(mavframe_frame_len(&p) == len);
    CHECK(mavframe_signature(&p) != NULL && mavframe_signature(&p)[0] == 0xA0 &&
          mavframe_signature(&p)[12] == 0xAC);
    CHECK(memcmp(mavframe_payload(&p), payload, 9) == 0);

    /* The signature bytes are skipped, so the next frame is found right after them. */
    memcpy(s, f, len);
    memcpy(s + len, g, lg);
    n = run_bytes(&p, s, len + lg, ev, 1);
    CHECK(n == 2 && ev[0].seq == 6 && ev[1].seq == 7 && p.stats.dropped_bytes == 0);

    /* Any other incompat flag is rejected as soon as the header is in. */
    f[2] = 0x03;
    mavframe_init(&p);
    for (i = 0; i < 9; i++)
        CHECK(mavframe_feed_byte(&p, f[i]) == MAVFRAME_NEED_MORE);
    CHECK(mavframe_feed_byte(&p, f[9]) == MAVFRAME_BAD_FLAGS);
    CHECK(p.stats.bad_flags == 1 && p.stats.frames == 0);
}

static void test_unknown_msgid(void)
{
    uint8_t f[MAVFRAME_MAX_FRAME], g[MAVFRAME_MAX_FRAME], s[2 * MAVFRAME_MAX_FRAME];
    uint8_t payload[9] = {0};
    size_t len = build(f, MSG_UNKNOWN, 8, payload, 9, 0);
    size_t lg = build(g, MSG_HEARTBEAT, 9, payload, 9, 0);
    size_t n, i;

    /* Reported as soon as the header is complete, never as a frame. */
    mavframe_init(&p);
    for (i = 0; i < 9; i++)
        CHECK(mavframe_feed_byte(&p, f[i]) == MAVFRAME_NEED_MORE);
    CHECK(mavframe_feed_byte(&p, f[9]) == MAVFRAME_UNKNOWN_MSGID);
    CHECK(mavframe_msgid(&p) == MSG_UNKNOWN);

    memcpy(s, f, len);
    memcpy(s + len, g, lg);
    n = run_bytes(&p, s, len + lg, ev, 1);
    CHECK(count(ev, n, MAVFRAME_UNKNOWN_MSGID) == 1);
    CHECK(count(ev, n, MAVFRAME_FRAME) == 1 && ev[n - 1].seq == 9);
    CHECK(p.stats.unknown_msgid == 1 && p.stats.frames == 1 && p.stats.dropped_bytes == len);
}

static void test_unpolled_events_are_safe(void)
{
    /* A caller that never polls loses hidden frames but must not break the parser. */
    uint8_t inner[MAVFRAME_MAX_FRAME], outer[MAVFRAME_MAX_FRAME], payload[200], small[9] = {0};
    size_t li, lo, i, frames = 0, round;

    li = build(inner, MSG_HEARTBEAT, 1, small, 9, 0);
    memset(payload, 0xFD, sizeof(payload));
    memcpy(payload + 10, inner, li);
    lo = build(outer, MSG_ATTITUDE, 2, payload, 200, 0);
    outer[lo - 2] ^= 1;
    mavframe_init(&p);
    for (round = 0; round < 50; round++)
        for (i = 0; i < lo; i++)
            frames += mavframe_feed_byte(&p, outer[i]) == MAVFRAME_FRAME;
    CHECK(p.stats.bytes == 50 * lo);
    /* The hidden frame of each round is found (and counted) while draining at
     * the next feed_byte call, where the caller never sees it. */
    CHECK(frames == 0 && p.stats.frames == 49);
    while (mavframe_poll(&p) != MAVFRAME_NEED_MORE) {
    }
    CHECK(p.stats.frames == 50);
    CHECK(mavframe_pending(&p) <= MAVFRAME_MAX_FRAME);
}

static uint32_t rng_state = 12345;
static uint32_t rng(void)
{
    rng_state = rng_state * 1664525u + 1013904223u;
    return rng_state >> 8;
}

static void test_byte_vs_chunk_identical(void)
{
    /* A fixed pseudo-random stream of valid, corrupted and cut frames plus
     * garbage must give the same events and counters however it is chunked. */
    static uint8_t s[60000];
    static const uint32_t ids[] = {0, 1, 24, 30, 33, 74, 253, 3 /* unknown */};
    static const size_t chunk_sizes[] = {2, 3, 7, 64, 279, 280, 281, 1000, sizeof(s)};
    uint8_t f[MAVFRAME_MAX_FRAME], payload[255];
    mavframe_stats ref;
    size_t total = 0, n, n2, i, c;

    while (total + 400 < sizeof(s)) {
        uint8_t len = (uint8_t)(rng() % 4 == 0 ? rng() % 256 : rng() % 40);
        size_t fl, kind = rng() % 10;
        for (i = 0; i < len; i++)
            payload[i] = (uint8_t)(rng() % 5 == 0 ? MAVFRAME_STX : rng());
        fl = build(f, ids[rng() % 8], (uint8_t)rng(), payload, len, rng() % 6 == 0);
        if (kind == 0)
            f[rng() % fl] ^= (uint8_t)(1u << (rng() % 8)); /* bit flip */
        else if (kind == 1)
            fl = rng() % fl; /* cut */
        else if (kind == 2)
            for (i = 0; i < 20; i++)
                s[total++] = (uint8_t)rng(); /* garbage first */
        memcpy(s + total, f, fl);
        total += fl;
    }
    n = run_bytes(&p, s, total, ev, 1);
    ref = p.stats;
    CHECK(n < MAX_EVENTS);
    CHECK(ref.frames > 100 && ref.bad_crc > 10 && ref.unknown_msgid > 10);
    CHECK(ref.bytes == total);
    for (c = 0; c < sizeof(chunk_sizes) / sizeof(chunk_sizes[0]); c++) {
        n2 = run_chunks(&p, s, total, chunk_sizes[c], ev2, 1);
        CHECK(n2 == n);
        CHECK(n2 == n && memcmp(ev, ev2, n * sizeof(ev[0])) == 0);
        CHECK(memcmp(&ref, &p.stats, sizeof(ref)) == 0);
    }
}

int main(void)
{
    test_crc_known_answer();
    test_crc_extra_table();
    test_heartbeat_fields();
    test_zero_length_payload();
    test_max_payload();
    test_v2_trimmed_payload();
    test_stream_cut_mid_payload();
    test_flush_releases_hidden_frame();
    test_bad_crc();
    test_resync_inside_corrupted_frame();
    test_bytes_after_rescanned_frame();
    test_garbage_between_frames();
    test_signed_frame();
    test_unknown_msgid();
    test_unpolled_events_are_safe();
    test_byte_vs_chunk_identical();
    printf("%d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
