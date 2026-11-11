/*
 * libFuzzer target. Beyond "does not crash under ASan/UBSan" it checks:
 *   1. feeding one byte at a time and feeding in chunks give the same events;
 *   2. every reported frame is a contiguous slice of the input at the offset
 *      the parser implies, and its CRC is correct when recomputed here;
 *   3. byte accounting: bytes in == frame bytes + dropped bytes + pending.
 *
 * The first input byte selects the chunk size; the rest is the stream.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mavframe.h"

#define REQUIRE(cond)                                                      \
    do {                                                                   \
        if (!(cond)) {                                                     \
            fprintf(stderr, "REQUIRE failed, line %d: %s\n", __LINE__, #cond); \
            abort();                                                       \
        }                                                                  \
    } while (0)

typedef struct {
    const uint8_t *data;
    size_t fed;          /* bytes consumed by the parser so far */
    uint64_t hash;       /* running hash of all events */
    uint64_t frame_bytes;
} run;

static void on_event(run *r, const mavframe_parser *p, mavframe_status st)
{
    r->hash = r->hash * 1099511628211ULL + (uint64_t)st;
    if (st == MAVFRAME_FRAME) {
        size_t off = r->fed - mavframe_pending(p);
        uint16_t flen = mavframe_frame_len(p);
        uint8_t len = mavframe_payload_len(p);
        const uint8_t *raw = mavframe_raw(p);
        uint8_t extra;
        uint16_t crc;

        REQUIRE(mavframe_pending(p) >= flen);
        REQUIRE(memcmp(raw, r->data + off, flen) == 0);
        REQUIRE(raw[0] == MAVFRAME_STX);
        REQUIRE((mavframe_incompat_flags(p) & ~MAVFRAME_IFLAG_SIGNED) == 0);
        REQUIRE(mavframe_crc_extra(mavframe_msgid(p), &extra));
        crc = mavframe_crc16(MAVFRAME_CRC_INIT, raw + 1, (size_t)9 + len);
        crc = mavframe_crc16(crc, &extra, 1);
        REQUIRE(raw[10 + len] == (crc & 0xFF) && raw[11 + len] == (crc >> 8));
        REQUIRE((mavframe_signature(p) != NULL) == mavframe_signed(p));
        r->frame_bytes += flen;
        r->hash = r->hash * 1099511628211ULL + off;
        r->hash = r->hash * 1099511628211ULL + flen;
    }
}

static void check_accounting(const run *r, const mavframe_parser *p)
{
    const mavframe_stats *s = mavframe_get_stats(p);
    REQUIRE(s->bytes == r->fed);
    REQUIRE(r->frame_bytes + s->dropped_bytes + mavframe_pending(p) - p->consume == s->bytes);
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    mavframe_parser a, b;
    mavframe_status st;
    run ra, rb;
    size_t chunk, base, i;

    if (size < 1)
        return 0;
    chunk = (size_t)data[0] + 1;
    data++;
    size--;
    memset(&ra, 0, sizeof(ra));
    memset(&rb, 0, sizeof(rb));
    ra.data = rb.data = data;

    /* Run A: one byte at a time. */
    mavframe_init(&a);
    for (i = 0; i < size; i++) {
        st = mavframe_feed_byte(&a, data[i]);
        ra.fed++;
        while (st != MAVFRAME_NEED_MORE) {
            on_event(&ra, &a, st);
            st = mavframe_poll(&a);
        }
        check_accounting(&ra, &a);
    }
    while ((st = mavframe_flush(&a)) != MAVFRAME_NEED_MORE)
        on_event(&ra, &a, st);
    check_accounting(&ra, &a);
    REQUIRE(mavframe_pending(&a) == 0);

    /* Run B: chunks. */
    mavframe_init(&b);
    for (base = 0; base < size; base += chunk) {
        size_t n = size - base < chunk ? size - base : chunk;
        size_t off = 0;
        while (off < n) {
            size_t used = mavframe_feed(&b, data + base + off, n - off, &st);
            off += used;
            rb.fed += used;
            if (st != MAVFRAME_NEED_MORE)
                on_event(&rb, &b, st);
        }
    }
    while ((st = mavframe_flush(&b)) != MAVFRAME_NEED_MORE)
        on_event(&rb, &b, st);
    check_accounting(&rb, &b);

    REQUIRE(ra.hash == rb.hash);
    REQUIRE(memcmp(mavframe_get_stats(&a), mavframe_get_stats(&b), sizeof(mavframe_stats)) == 0);
    return 0;
}
