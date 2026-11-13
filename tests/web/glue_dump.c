/*
 * Native build of the browser glue (web/wasm/mavframe_wasm.c + src/mavframe.c,
 * the same two files tools/build_wasm.sh compiles to WebAssembly). Reads a
 * stream from stdin, feeds it in the read sizes given on the command line,
 * and prints every recorded event and the final counters in the same form
 * as rawEvents() in docs/js/core.js, so tests/web/test_wasm.mjs can compare
 * the native and WebAssembly builds event by event.
 *
 *   glue_dump 7 13 100     reads of 7, 13 and 100 bytes, then the rest in one read
 *   glue_dump c5           the whole stream in reads of 5 bytes
 *   glue_dump              the whole stream in one read
 *
 * Output: one line per event "off msgid status seq sysid compid len iflags flen",
 * then "stats bytes frames bad_crc unknown_msgid bad_flags dropped_bytes".
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mavframe.h"

void mfw_reset(void);
uint8_t *mfw_input(void);
uint32_t mfw_input_cap(void);
const void *mfw_events(void);
uint32_t mfw_event_count(void);
const mavframe_stats *mfw_stats(void);
uint32_t mfw_feed(uint32_t start, uint32_t len);
uint32_t mfw_flush(void);

static void take(void)
{
    const uint8_t *e = (const uint8_t *)mfw_events();
    uint32_t i, n = mfw_event_count();
    for (i = 0; i < n; i++, e += 16) {
        printf("%lu %lu %u %u %u %u %u %u %u\n",
               (unsigned long)((uint32_t)e[0] | (uint32_t)e[1] << 8 | (uint32_t)e[2] << 16 | (uint32_t)e[3] << 24),
               (unsigned long)((uint32_t)e[4] | (uint32_t)e[5] << 8 | (uint32_t)e[6] << 16 | (uint32_t)e[7] << 24),
               e[8], e[9], e[10], e[11], e[12], e[13], (unsigned)(e[14] | e[15] << 8));
    }
}

static void feed(const uint8_t *data, size_t len)
{
    uint32_t used = 0;
    memcpy(mfw_input(), data, len);
    while (used < len) {
        used += mfw_feed(used, (uint32_t)len - used);
        take();
    }
}

int main(int argc, char **argv)
{
    static uint8_t buf[1 << 20];
    size_t n = fread(buf, 1, sizeof(buf), stdin), pos = 0;
    const mavframe_stats *s;
    int a;

    if (!feof(stdin) || n > mfw_input_cap()) {
        fprintf(stderr, "input must be at most %lu bytes\n", (unsigned long)mfw_input_cap());
        return 2;
    }
    mfw_reset();
    for (a = 1; a < argc && pos < n; a++) {
        size_t r;
        if (argv[a][0] == 'c') {
            size_t chunk = strtoul(argv[a] + 1, NULL, 10);
            if (chunk == 0)
                return 2;
            for (; pos < n; pos += r) {
                r = n - pos < chunk ? n - pos : chunk;
                feed(buf + pos, r);
            }
            break;
        }
        r = strtoul(argv[a], NULL, 10);
        if (r > n - pos)
            r = n - pos;
        feed(buf + pos, r);
        pos += r;
    }
    if (pos < n)
        feed(buf + pos, n - pos);
    while (!mfw_flush())
        take();
    take();
    s = mfw_stats();
    printf("stats %lu %lu %lu %lu %lu %lu\n", (unsigned long)s->bytes, (unsigned long)s->frames,
           (unsigned long)s->bad_crc, (unsigned long)s->unknown_msgid, (unsigned long)s->bad_flags,
           (unsigned long)s->dropped_bytes);
    return 0;
}
