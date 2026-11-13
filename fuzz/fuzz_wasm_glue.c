/*
 * libFuzzer target for the WebAssembly glue (web/wasm/mavframe_wasm.c),
 * built natively so ASan/UBSan can watch it. It drives the same exported
 * functions the browser calls and checks every recorded event:
 *   - the event lies inside the bytes fed so far and starts with 0xFD;
 *   - its header fields equal the input bytes at its offset;
 *   - a frame's length matches its header;
 *   - per-status event counts equal the parser's own counters (no event lost).
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

/* Exported by web/wasm/mavframe_wasm.c (no header: JS is the usual caller). */
void mfw_reset(void);
uint8_t *mfw_input(void);
uint32_t mfw_input_cap(void);
const void *mfw_events(void);
uint32_t mfw_event_count(void);
const mavframe_stats *mfw_stats(void);
uint32_t mfw_feed(uint32_t start, uint32_t len);
uint32_t mfw_flush(void);

static const uint8_t *stream;
static uint32_t seen[6];

static uint32_t rd32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }

static void check_events(void)
{
    const uint8_t *ev = (const uint8_t *)mfw_events();
    uint32_t n = mfw_event_count(), i;
    uint32_t fed = mfw_stats()->bytes;

    for (i = 0; i < n; i++) {
        const uint8_t *e = ev + 16 * i;
        uint32_t off = rd32(e), msgid = rd32(e + 4);
        uint8_t st = e[8];
        uint16_t flen = (uint16_t)(e[14] | e[15] << 8);
        const uint8_t *b = stream + off;

        REQUIRE(st >= MAVFRAME_FRAME && st <= MAVFRAME_BAD_FLAGS);
        REQUIRE(flen >= MAVFRAME_HEADER_LEN && off + flen <= fed);
        REQUIRE(b[0] == MAVFRAME_STX);
        REQUIRE(msgid == ((uint32_t)b[7] | (uint32_t)b[8] << 8 | (uint32_t)b[9] << 16));
        REQUIRE(e[9] == b[4] && e[10] == b[5] && e[11] == b[6] && e[12] == b[1] && e[13] == b[2]);
        if (st == MAVFRAME_FRAME || st == MAVFRAME_BAD_CRC)
            REQUIRE(flen == MAVFRAME_HEADER_LEN + b[1] + MAVFRAME_CRC_LEN + ((b[2] & 1) ? MAVFRAME_SIGNATURE_LEN : 0));
        seen[st]++;
    }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    const mavframe_stats *s;
    size_t chunk, pos;

    if (size < 1)
        return 0;
    chunk = (size_t)data[0] + 1;
    stream = data + 1;
    size--;
    memset(seen, 0, sizeof(seen));
    REQUIRE(mfw_input_cap() >= 256);

    mfw_reset();
    for (pos = 0; pos < size; pos += chunk) {
        uint32_t len = (uint32_t)(size - pos < chunk ? size - pos : chunk), used = 0;
        memcpy(mfw_input(), stream + pos, len);
        while (used < len) {
            uint32_t k = mfw_feed(used, len - used);
            check_events();
            REQUIRE(k > 0 || mfw_event_count() > 0);
            used += k;
        }
    }
    while (!mfw_flush())
        check_events();
    check_events();

    /* Out-of-range requests are refused, not read past the buffer. */
    REQUIRE(mfw_feed(mfw_input_cap(), 1) == 0);
    REQUIRE(mfw_feed(1, mfw_input_cap()) == 0);
    REQUIRE(mfw_feed(0xFFFFFFFFu, 2) == 0);

    s = mfw_stats();
    REQUIRE(s->bytes == size);
    REQUIRE(seen[MAVFRAME_FRAME] == s->frames);
    REQUIRE(seen[MAVFRAME_BAD_CRC] == s->bad_crc);
    REQUIRE(seen[MAVFRAME_UNKNOWN_MSGID] == s->unknown_msgid);
    REQUIRE(seen[MAVFRAME_BAD_FLAGS] == s->bad_flags);
    return 0;
}
