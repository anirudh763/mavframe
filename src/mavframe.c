/*
 * mavframe - MAVLink v2 frame parser. See include/mavframe.h for the API.
 *
 * How it works: bytes are appended to a fixed 280-byte buffer (the largest
 * possible v2 frame). step() looks at buf[head..tail) and reports at most
 * one event:
 *
 *   - buf[head] is not a start byte (0xFD)     -> drop up to the next one
 *   - fewer than 10 bytes                      -> need more
 *   - unsupported incompat flags               -> fail
 *   - message id not in the CRC_EXTRA table    -> fail
 *   - fewer bytes than the header announces    -> need more
 *   - CRC mismatch                             -> fail
 *   - otherwise                                -> frame
 *
 * A failure releases only the start byte plus whatever lies before the next
 * 0xFD in the buffer. The following bytes stay buffered and are examined
 * again from that next 0xFD, so a valid frame that begins inside a corrupted
 * one is still found. Released bytes are removed lazily on the next call so
 * the accessors can keep pointing at the frame that was just reported.
 */
#include "mavframe.h"

#include <string.h>

#include "mavframe_crc_extra_common.h"

void mavframe_init(mavframe_parser *p)
{
    memset(p, 0, sizeof(*p));
}

uint16_t mavframe_crc16(uint16_t crc, const uint8_t *data, size_t len)
{
    size_t i;
    for (i = 0; i < len; i++) {
        uint8_t tmp = (uint8_t)(data[i] ^ (uint8_t)(crc & 0xFF));
        tmp = (uint8_t)(tmp ^ (uint8_t)(tmp << 4));
        crc = (uint16_t)((crc >> 8) ^ ((uint16_t)tmp << 8) ^ ((uint16_t)tmp << 3) ^ (tmp >> 4));
    }
    return crc;
}

int mavframe_crc_extra(uint32_t msgid, uint8_t *extra)
{
    /* Binary search; each table entry is (msgid << 8) | crc_extra, sorted. */
    size_t lo = 0;
    size_t hi = sizeof(mavframe_crc_extra_table) / sizeof(mavframe_crc_extra_table[0]);
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        uint32_t id = mavframe_crc_extra_table[mid] >> 8;
        if (id == msgid) {
            *extra = (uint8_t)(mavframe_crc_extra_table[mid] & 0xFF);
            return 1;
        }
        if (id < msgid)
            lo = mid + 1;
        else
            hi = mid;
    }
    return 0;
}

/* Give up on the candidate at head: release it and everything before the
 * next start byte. The rest of the buffer is re-examined on the next step. */
static mavframe_status fail(mavframe_parser *p, mavframe_status why)
{
    const uint8_t *b = p->buf + p->head;
    uint16_t avail = (uint16_t)(p->tail - p->head);
    const uint8_t *next = memchr(b + 1, MAVFRAME_STX, (size_t)(avail - 1));

    p->consume = next ? (uint16_t)(next - b) : avail;
    p->stats.dropped_bytes += p->consume;
    if (why == MAVFRAME_BAD_CRC)
        p->stats.bad_crc++;
    else if (why == MAVFRAME_UNKNOWN_MSGID)
        p->stats.unknown_msgid++;
    else if (why == MAVFRAME_BAD_FLAGS)
        p->stats.bad_flags++;
    return why;
}

/* Number of bytes the candidate at head needs before step() can decide more:
 * the header first, then the whole frame. */
static uint16_t bytes_needed(const uint8_t *b, uint16_t avail)
{
    if (avail < MAVFRAME_HEADER_LEN)
        return MAVFRAME_HEADER_LEN;
    return (uint16_t)(MAVFRAME_HEADER_LEN + b[1] + MAVFRAME_CRC_LEN +
                      ((b[2] & MAVFRAME_IFLAG_SIGNED) ? MAVFRAME_SIGNATURE_LEN : 0));
}

static mavframe_status step(mavframe_parser *p)
{
    const uint8_t *b;
    uint16_t avail, total, crc;
    uint8_t extra;
    uint32_t msgid;

    /* Fast path for the common call: nothing was released and the candidate
     * still lacks bytes, so the checks below would give the same answer. */
    if (p->consume == 0 && (uint16_t)(p->tail - p->head) < p->need)
        return MAVFRAME_NEED_MORE;

    p->head = (uint16_t)(p->head + p->consume);
    p->consume = 0;
    avail = (uint16_t)(p->tail - p->head);
    b = p->buf + p->head;

    /* After a frame found during a rescan, the bytes behind it are whatever
     * came next in the stream, not necessarily a start byte. */
    if (avail > 0 && b[0] != MAVFRAME_STX)
        return fail(p, MAVFRAME_DROPPED);

    if (avail >= MAVFRAME_HEADER_LEN) {
        if (b[2] & (uint8_t)~MAVFRAME_IFLAG_SIGNED)
            return fail(p, MAVFRAME_BAD_FLAGS);
        msgid = (uint32_t)b[7] | ((uint32_t)b[8] << 8) | ((uint32_t)b[9] << 16);
        if (!mavframe_crc_extra(msgid, &extra))
            return fail(p, MAVFRAME_UNKNOWN_MSGID);
        total = bytes_needed(b, avail);
        if (avail >= total) {
            const uint8_t *c = b + MAVFRAME_HEADER_LEN + b[1];
            crc = mavframe_crc16(MAVFRAME_CRC_INIT, b + 1, (size_t)(MAVFRAME_HEADER_LEN - 1) + b[1]);
            crc = mavframe_crc16(crc, &extra, 1);
            if (crc != (uint16_t)(c[0] | ((uint16_t)c[1] << 8)))
                return fail(p, MAVFRAME_BAD_CRC);
            p->consume = total;
            p->stats.frames++;
            return MAVFRAME_FRAME;
        }
    }

    /* Nothing to report. Move what is left to the front so that a whole
     * frame always fits behind it. */
    if (p->head > 0) {
        memmove(p->buf, b, avail);
        p->head = 0;
        p->tail = avail;
    }
    p->need = bytes_needed(p->buf, avail);
    return MAVFRAME_NEED_MORE;
}

mavframe_status mavframe_poll(mavframe_parser *p)
{
    return step(p);
}

size_t mavframe_feed(mavframe_parser *p, const uint8_t *data, size_t len, mavframe_status *status)
{
    size_t used = 0;

    *status = step(p);
    while (*status == MAVFRAME_NEED_MORE && used < len) {
        size_t n;
        if (p->tail == 0) {
            /* Empty buffer: only a start byte may enter it. */
            if (data[used] != MAVFRAME_STX) {
                used++;
                p->stats.bytes++;
                p->stats.dropped_bytes++;
                *status = MAVFRAME_DROPPED;
                break;
            }
            n = 1;
        } else {
            /* Take no more than the candidate needs for its next decision,
             * so the result does not depend on how the input is chunked. */
            n = (size_t)(p->need - p->tail);
            if (n > len - used)
                n = len - used;
        }
        memcpy(p->buf + p->tail, data + used, n);
        p->tail = (uint16_t)(p->tail + n);
        p->stats.bytes += (uint32_t)n;
        used += n;
        *status = step(p);
    }
    return used;
}

mavframe_status mavframe_feed_byte(mavframe_parser *p, uint8_t byte)
{
    mavframe_status st;

    /* Events the caller did not poll for are dropped here (still counted). */
    while (step(p) != MAVFRAME_NEED_MORE) {
    }
    (void)mavframe_feed(p, &byte, 1, &st);
    return st;
}

mavframe_status mavframe_flush(mavframe_parser *p)
{
    mavframe_status st = step(p);

    if (st != MAVFRAME_NEED_MORE || p->tail == 0)
        return st;
    return fail(p, MAVFRAME_DROPPED);
}
