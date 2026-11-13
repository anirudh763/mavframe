/*
 * mavframe-dump: read a MAVLink v2 byte stream from FILE (or stdin), print one
 * line per decoded frame to stdout and a summary of the parser counters to stderr.
 *
 *   off=<stream offset> msgid=<n> sysid=<n> compid=<n> seq=<n> len=<n> signed=<0|1> payload=<hex>
 *
 * Exit status: 0 on success, 1 if the input cannot be opened or read, 2 for bad arguments.
 */
#include <errno.h>
#include <stdio.h>
#include <string.h>

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

static void usage(FILE *out)
{
    fputs("usage: mavframe-dump [FILE]\n"
          "       mavframe-dump --help | --version\n"
          "\n"
          "Find MAVLink v2 frames in a raw byte stream read from FILE, or from\n"
          "standard input when FILE is missing or '-'. Prints one line per valid\n"
          "frame to stdout and the parser counters to stderr. The input is raw\n"
          "bytes: a .tlog file also works, but its 8-byte timestamps count as\n"
          "dropped bytes.\n"
          "\n"
          "Exit status: 0 on success, 1 if the input cannot be opened or read,\n"
          "2 for bad arguments.\n",
          out);
}

int main(int argc, char **argv)
{
    static uint8_t in[65536];
    mavframe_parser p;
    mavframe_status st;
    const mavframe_stats *s;
    const char *name = NULL;
    FILE *f = stdin;
    size_t n;
    int i;

    for (i = 1; i < argc; i++) {
        const char *a = argv[i];
        if (strcmp(a, "--help") == 0 || strcmp(a, "-h") == 0) {
            usage(stdout);
            return 0;
        }
        if (strcmp(a, "--version") == 0) {
            printf("mavframe-dump %s\n", MAVFRAME_VERSION_STRING);
            return 0;
        }
        if ((a[0] == '-' && a[1] != '\0') || name != NULL) {
            fprintf(stderr, "mavframe-dump: %s: %s\n",
                    name != NULL ? "too many arguments" : "unknown option", a);
            usage(stderr);
            return 2;
        }
        name = a;
    }
    if (name != NULL && strcmp(name, "-") != 0) {
        f = fopen(name, "rb");
        if (f == NULL) {
            fprintf(stderr, "mavframe-dump: cannot open %s: %s\n", name, strerror(errno));
            return 1;
        }
    } else {
        name = "standard input";
    }

    mavframe_init(&p);
    while ((n = fread(in, 1, sizeof(in), f)) > 0) {
        size_t off = 0;
        while (off < n) {
            size_t used = mavframe_feed(&p, in + off, n - off, &st);
            off += used;
            fed += used;
            handle(&p, st);
        }
    }
    if (ferror(f)) {
        fprintf(stderr, "mavframe-dump: cannot read %s: %s\n", name, strerror(errno));
        return 1;
    }
    if (f != stdin)
        fclose(f);

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
    return 0;
}
