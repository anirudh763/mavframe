/*
 * mavframe-bench: parse a byte stream held in memory several times and
 * report the median throughput.
 *
 *   mavframe-bench <stream file> [repetitions=11] [passes per repetition=20]
 */
#define _POSIX_C_SOURCE 199309L
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#include "mavframe.h"

static double now(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

static int cmp_double(const void *a, const void *b)
{
    double x = *(const double *)a, y = *(const double *)b;
    return (x > y) - (x < y);
}

/* Returns frames found. sink keeps the compiler from dropping the payload access. */
static unsigned long parse_chunked(const uint8_t *data, size_t len, unsigned *sink)
{
    mavframe_parser p;
    mavframe_status st;
    size_t off = 0;

    mavframe_init(&p);
    while (off < len) {
        off += mavframe_feed(&p, data + off, len - off, &st);
        if (st == MAVFRAME_FRAME)
            *sink += mavframe_payload(&p)[0] + mavframe_msgid(&p);
    }
    return mavframe_get_stats(&p)->frames;
}

static unsigned long parse_bytewise(const uint8_t *data, size_t len, unsigned *sink)
{
    mavframe_parser p;
    mavframe_status st;
    size_t i;

    mavframe_init(&p);
    for (i = 0; i < len; i++) {
        st = mavframe_feed_byte(&p, data[i]);
        while (st != MAVFRAME_NEED_MORE) {
            if (st == MAVFRAME_FRAME)
                *sink += mavframe_payload(&p)[0] + mavframe_msgid(&p);
            st = mavframe_poll(&p);
        }
    }
    return mavframe_get_stats(&p)->frames;
}

static void run(const char *name, unsigned long (*fn)(const uint8_t *, size_t, unsigned *),
                const uint8_t *data, size_t len, int reps, int passes)
{
    double *t = malloc((size_t)reps * sizeof(*t));
    unsigned long frames = 0;
    unsigned sink = 0;
    double med;
    int r, k;

    if (!t)
        exit(1);
    for (r = 0; r < reps; r++) {
        double t0 = now();
        for (k = 0; k < passes; k++)
            frames = fn(data, len, &sink);
        t[r] = (now() - t0) / passes;
    }
    qsort(t, (size_t)reps, sizeof(*t), cmp_double);
    med = t[reps / 2];
    printf("%-10s frames/pass=%lu  median %.1f MB/s  %.2f M frames/s  (min %.1f, max %.1f MB/s over %d reps, sink=%u)\n",
           name, frames, (double)len / 1e6 / med, (double)frames / 1e6 / med,
           (double)len / 1e6 / t[reps - 1], (double)len / 1e6 / t[0], reps, sink & 1u);
    free(t);
}

/* Read the whole stream. A regular file is sized with fseek/ftell; a pipe or
 * other non-seekable input (ftell fails) is read in growing chunks instead.
 * Returns NULL, with nothing left allocated, on any read or allocation error. */
static uint8_t *read_all(FILE *f, long *size)
{
    size_t cap = 1u << 16, len = 0, n;
    uint8_t *buf, *tmp;
    long end = -1;

    /* The size is only a hint (a directory reports LONG_MAX), so it is capped;
     * the loop below grows the buffer for anything larger. */
    if (fseek(f, 0, SEEK_END) == 0 && (end = ftell(f)) >= 0 && fseek(f, 0, SEEK_SET) == 0)
        cap = (size_t)(end < (1L << 28) ? end : (1L << 28)) + 1;
    else
        clearerr(f);
    if (!(buf = malloc(cap)))
        return NULL;
    while ((n = fread(buf + len, 1, cap - len, f)) > 0) {
        len += n;
        if (len == cap) {
            if (cap > (size_t)LONG_MAX / 2 || !(tmp = realloc(buf, cap * 2))) {
                free(buf);
                return NULL;
            }
            buf = tmp;
            cap *= 2;
        }
    }
    if (ferror(f)) {
        free(buf);
        return NULL;
    }
    *size = (long)len;
    return buf;
}

int main(int argc, char **argv)
{
    FILE *f;
    long size;
    uint8_t *data;
    int reps = argc > 2 ? atoi(argv[2]) : 11;
    int passes = argc > 3 ? atoi(argv[3]) : 20;

    if (argc < 2 || reps < 1 || passes < 1 || !(f = fopen(argv[1], "rb"))) {
        fprintf(stderr, "usage: %s <stream file> [repetitions] [passes]\n", argv[0]);
        return 1;
    }
    data = read_all(f, &size);
    fclose(f);
    if (!data) {
        fprintf(stderr, "%s: cannot read %s\n", argv[0], argv[1]);
        return 1;
    }
    printf("stream: %ld bytes, %d repetitions x %d passes\n", size, reps, passes);
    run("chunked", parse_chunked, data, (size_t)size, reps, passes);
    run("bytewise", parse_bytewise, data, (size_t)size, reps, passes);
    free(data);
    return 0;
}
