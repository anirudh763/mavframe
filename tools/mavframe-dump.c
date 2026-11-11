/*
 * mavframe-dump: read a MAVLink v2 byte stream from stdin, print one line per
 * decoded frame to stdout and a summary of the parser counters to stderr.
 *
 *   off=<stream offset> msgid=<n> sysid=<n> compid=<n> seq=<n> len=<n> signed=<0|1> payload=<hex>
 */
#include <stdio.h>

#include "mavframe.h"

static unsigned long long fed; /* bytes handed to the parser so far */

static void handle(const mavframe_parser *p, mavframe_status st)
{
    const uint8_t *payload;
    unsigned i, len;

    if (st != MAVFRAME_FRAME)
        return;
    payload = mavframe_payload(p);
    len = mavframe_payload_len(p);
    printf("off=%llu msgid=%lu sysid=%u compid=%u seq=%u len=%u signed=%d payload=",
           fed - mavframe_pending(p), (unsigned long)mavframe_msgid(p), (unsigned)mavframe_sysid(p),
           (unsigned)mavframe_compid(p), (unsigned)mavframe_seq(p), len, mavframe_signed(p));
    for (i = 0; i < len; i++)
        printf("%02x", (unsigned)payload[i]);
    putchar('\n');
}

int main(void)
{
    static uint8_t in[65536];
    mavframe_parser p;
    mavframe_status st;
    const mavframe_stats *s;
    size_t n;

    mavframe_init(&p);
    while ((n = fread(in, 1, sizeof(in), stdin)) > 0) {
        size_t off = 0;
        while (off < n) {
            size_t used = mavframe_feed(&p, in + off, n - off, &st);
            off += used;
            fed += used;
            handle(&p, st);
        }
    }
    /* End of input: an unfinished frame may still hide complete ones. */
    do {
        st = mavframe_flush(&p);
        handle(&p, st);
    } while (st != MAVFRAME_NEED_MORE);

    s = mavframe_get_stats(&p);
    fprintf(stderr, "bytes=%llu frames=%lu bad_crc=%lu unknown_msgid=%lu bad_flags=%lu dropped_bytes=%lu\n",
            fed, (unsigned long)s->frames, (unsigned long)s->bad_crc,
            (unsigned long)s->unknown_msgid, (unsigned long)s->bad_flags,
            (unsigned long)s->dropped_bytes);
    return ferror(stdin) ? 1 : 0;
}
