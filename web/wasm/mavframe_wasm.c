/*
 * WebAssembly glue for the browser inspector (docs/). Compiled together with
 * the unchanged src/mavframe.c by tools/build_wasm.sh.
 *
 * JavaScript copies a chunk of the capture into input_buf, calls
 * mfw_feed(start, len) and reads back the events written to event_buf. Each
 * call stops when the input range is used up or the event buffer is full, so
 * JS loops until every byte of the chunk is consumed. Events are 16 bytes:
 *
 *   0  u32 stream offset of the frame / candidate start byte
 *   4  u32 message id (from the header, also for rejected candidates)
 *   8  u8  mavframe_status (FRAME, BAD_CRC, UNKNOWN_MSGID, BAD_FLAGS)
 *   9  u8  seq   10 u8 sysid   11 u8 compid   12 u8 payload length
 *   13 u8  incompat flags
 *   14 u16 frame length the header announces (header only for UNKNOWN/BAD_FLAGS)
 *
 * MAVFRAME_DROPPED events are not recorded one by one (garbage would produce
 * one per byte); the parser's dropped_bytes counter covers them.
 *
 * There is no libc on wasm32-freestanding, so the four <string.h> functions
 * the parser calls are defined at the bottom of this file (wasm only; the
 * file also builds natively for the fuzz target fuzz/fuzz_wasm_glue.c). Offsets are
 * 32-bit: captures must be smaller than 4 GiB (the UI limits them far below).
 */
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "mavframe.h"

#define INPUT_CAP (1u << 20)
#define EVENT_CAP 8192u

typedef struct {
    uint32_t off;
    uint32_t msgid;
    uint8_t status, seq, sysid, compid, len, iflags;
    uint16_t frame_len;
} mfw_event;

typedef char mfw_event_is_16_bytes[sizeof(mfw_event) == 16 ? 1 : -1];

static mavframe_parser parser;
static uint8_t input_buf[INPUT_CAP];
static mfw_event event_buf[EVENT_CAP];
static uint32_t event_count;
static uint8_t scratch_buf[MAVFRAME_MAX_FRAME];

static void record(mavframe_status st)
{
    const uint8_t *b;
    mfw_event *e;

    if (st == MAVFRAME_NEED_MORE || st == MAVFRAME_DROPPED || event_count >= EVENT_CAP)
        return;
    /* For FRAME and the three failures the candidate still sits at
     * buf[head] with at least a full header buffered: fail() releases it
     * lazily, on the next call. */
    b = mavframe_raw(&parser);
    e = &event_buf[event_count++];
    e->off = parser.stats.bytes - mavframe_pending(&parser);
    e->msgid = (uint32_t)b[7] | ((uint32_t)b[8] << 8) | ((uint32_t)b[9] << 16);
    e->status = (uint8_t)st;
    e->seq = b[4];
    e->sysid = b[5];
    e->compid = b[6];
    e->len = b[1];
    e->iflags = b[2];
    e->frame_len = (st == MAVFRAME_FRAME || st == MAVFRAME_BAD_CRC) ? mavframe_frame_len(&parser)
                                                                    : MAVFRAME_HEADER_LEN;
}

void mfw_reset(void)
{
    mavframe_init(&parser);
    event_count = 0;
}

uint8_t *mfw_input(void) { return input_buf; }
/* Room for one frame, so the UI can run mavframe_crc16() on a selected frame. */
uint8_t *mfw_scratch(void) { return scratch_buf; }
uint32_t mfw_input_cap(void) { return INPUT_CAP; }
mfw_event *mfw_events(void) { return event_buf; }
uint32_t mfw_event_cap(void) { return EVENT_CAP; }
uint32_t mfw_event_count(void) { return event_count; }
const mavframe_stats *mfw_stats(void) { return mavframe_get_stats(&parser); }

/* Parse input_buf[start .. start+len). Clears the event buffer first.
 * Returns the number of bytes consumed; less than len means the event
 * buffer filled up and the caller must read it and call again. */
uint32_t mfw_feed(uint32_t start, uint32_t len)
{
    uint32_t used = 0;
    mavframe_status st;

    event_count = 0;
    if (start > INPUT_CAP || len > INPUT_CAP - start)
        return 0;
    while (used < len && event_count < EVENT_CAP) {
        used += (uint32_t)mavframe_feed(&parser, input_buf + start + used, len - used, &st);
        record(st);
    }
    return used;
}

/* End of capture. Clears the event buffer first. Returns 1 when the parser
 * has nothing left, 0 when the event buffer filled up (call again). */
uint32_t mfw_flush(void)
{
    mavframe_status st;

    event_count = 0;
    while (event_count < EVENT_CAP) {
        st = mavframe_flush(&parser);
        if (st == MAVFRAME_NEED_MORE)
            return 1;
        record(st);
    }
    return 0;
}

#if defined(__wasm__)
/* Freestanding replacements for the libc functions mavframe.c uses. Built
 * with -fno-builtin so the loops are not turned back into calls to
 * themselves. Native builds of this file (fuzz/fuzz_wasm_glue.c) use libc. */
void *memcpy(void *dst, const void *src, size_t n)
{
    uint8_t *d = dst;
    const uint8_t *s = src;
    while (n--)
        *d++ = *s++;
    return dst;
}

void *memmove(void *dst, const void *src, size_t n)
{
    uint8_t *d = dst;
    const uint8_t *s = src;
    if (d < s) {
        while (n--)
            *d++ = *s++;
    } else if (d > s) {
        d += n;
        s += n;
        while (n--)
            *--d = *--s;
    }
    return dst;
}

void *memset(void *dst, int c, size_t n)
{
    uint8_t *d = dst;
    while (n--)
        *d++ = (uint8_t)c;
    return dst;
}

void *memchr(const void *s, int c, size_t n)
{
    const uint8_t *p = s;
    for (; n; n--, p++)
        if (*p == (uint8_t)c)
            return (void *)p;
    return NULL;
}
#endif /* __wasm__ */
