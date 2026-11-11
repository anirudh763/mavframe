/*
 * mavframe - a small MAVLink v2 frame parser with no heap allocation.
 *
 * Frame layout (MAVLink v2):
 *   0      STX (0xFD)
 *   1      payload length (0..255)
 *   2      incompat flags (0x01 = signed)
 *   3      compat flags
 *   4      sequence
 *   5      system id
 *   6      component id
 *   7..9   message id, 24 bit little endian
 *   10..   payload
 *   then   CRC-16/MCRF4XX, little endian, over bytes 1..9 + payload + CRC_EXTRA
 *   then   13-byte signature, only if incompat flag 0x01 is set
 *
 * Usage:
 *   mavframe_parser p;
 *   mavframe_init(&p);
 *   for each received byte b:
 *       mavframe_status st = mavframe_feed_byte(&p, b);
 *       while (st != MAVFRAME_NEED_MORE) {
 *           if (st == MAVFRAME_FRAME) use mavframe_msgid(&p), mavframe_payload(&p), ...
 *           st = mavframe_poll(&p);
 *       }
 *
 * One input byte can produce more than one event (a failed frame can hide a
 * complete valid frame in the bytes already buffered), which is why the
 * poll loop exists.
 */
#ifndef MAVFRAME_H
#define MAVFRAME_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MAVFRAME_STX 0xFD
#define MAVFRAME_HEADER_LEN 10
#define MAVFRAME_MAX_PAYLOAD 255
#define MAVFRAME_CRC_LEN 2
#define MAVFRAME_SIGNATURE_LEN 13
#define MAVFRAME_MAX_FRAME \
    (MAVFRAME_HEADER_LEN + MAVFRAME_MAX_PAYLOAD + MAVFRAME_CRC_LEN + MAVFRAME_SIGNATURE_LEN)
#define MAVFRAME_IFLAG_SIGNED 0x01
#define MAVFRAME_CRC_INIT 0xFFFF

typedef enum {
    MAVFRAME_NEED_MORE = 0, /* nothing to report; feed more bytes */
    MAVFRAME_FRAME,         /* a frame with a valid CRC is ready; accessors are valid */
    MAVFRAME_BAD_CRC,       /* a complete frame failed its CRC */
    MAVFRAME_UNKNOWN_MSGID, /* message id has no CRC_EXTRA in the table; CRC cannot be checked */
    MAVFRAME_BAD_FLAGS,     /* incompat flags other than 0x01 are set */
    MAVFRAME_DROPPED        /* byte(s) discarded outside any frame, or an unfinished frame flushed */
} mavframe_status;

typedef struct {
    uint32_t bytes;         /* bytes accepted from the caller */
    uint32_t frames;        /* MAVFRAME_FRAME events */
    uint32_t bad_crc;       /* MAVFRAME_BAD_CRC events */
    uint32_t unknown_msgid; /* MAVFRAME_UNKNOWN_MSGID events */
    uint32_t bad_flags;     /* MAVFRAME_BAD_FLAGS events */
    uint32_t dropped_bytes; /* bytes that did not end up inside a reported frame */
} mavframe_stats;

typedef struct {
    uint8_t buf[MAVFRAME_MAX_FRAME]; /* candidate frame starts at buf[head] */
    uint16_t head;                   /* index of the candidate start byte */
    uint16_t tail;                   /* one past the last buffered byte */
    uint16_t consume;                /* bytes to release from head on the next call */
    uint16_t need;                   /* buffered bytes required before the next decision */
    mavframe_stats stats;
} mavframe_parser;

void mavframe_init(mavframe_parser *p);

/* Accept one byte and return the first event it causes. If the result is not
 * MAVFRAME_NEED_MORE, call mavframe_poll() until it returns MAVFRAME_NEED_MORE.
 * Events left unpolled are counted in the stats but otherwise discarded by the
 * next mavframe_feed_byte() call. */
mavframe_status mavframe_feed_byte(mavframe_parser *p, uint8_t byte);

/* Return the next pending event without new input. */
mavframe_status mavframe_poll(mavframe_parser *p);

/* Chunk version: consume bytes from data until one event occurs or the data
 * runs out. Returns the number of bytes consumed (may be 0 when an event was
 * still pending) and stores the event in *status. Produces exactly the same
 * event sequence as feeding the same bytes one at a time. */
size_t mavframe_feed(mavframe_parser *p, const uint8_t *data, size_t len, mavframe_status *status);

/* End of stream or link idle timeout: give up on an unfinished frame and
 * rescan what is buffered. Call until it returns MAVFRAME_NEED_MORE. */
mavframe_status mavframe_flush(mavframe_parser *p);

/* CRC-16/MCRF4XX (the MAVLink "X25" checksum), continuing from crc. */
uint16_t mavframe_crc16(uint16_t crc, const uint8_t *data, size_t len);

/* Look up CRC_EXTRA for a message id. Returns 1 if known, 0 if not. */
int mavframe_crc_extra(uint32_t msgid, uint8_t *extra);

/* Accessors. All are valid after MAVFRAME_FRAME until the next feed, poll or
 * flush call. The pointers point into the parser's own buffer. */
static inline const uint8_t *mavframe_raw(const mavframe_parser *p) { return p->buf + p->head; }
static inline uint8_t mavframe_payload_len(const mavframe_parser *p) { return mavframe_raw(p)[1]; }
static inline uint8_t mavframe_incompat_flags(const mavframe_parser *p) { return mavframe_raw(p)[2]; }
static inline uint8_t mavframe_compat_flags(const mavframe_parser *p) { return mavframe_raw(p)[3]; }
static inline uint8_t mavframe_seq(const mavframe_parser *p) { return mavframe_raw(p)[4]; }
static inline uint8_t mavframe_sysid(const mavframe_parser *p) { return mavframe_raw(p)[5]; }
static inline uint8_t mavframe_compid(const mavframe_parser *p) { return mavframe_raw(p)[6]; }
static inline uint32_t mavframe_msgid(const mavframe_parser *p)
{
    const uint8_t *b = mavframe_raw(p);
    return (uint32_t)b[7] | ((uint32_t)b[8] << 8) | ((uint32_t)b[9] << 16);
}
static inline const uint8_t *mavframe_payload(const mavframe_parser *p)
{
    return mavframe_raw(p) + MAVFRAME_HEADER_LEN;
}
static inline int mavframe_signed(const mavframe_parser *p)
{
    return (mavframe_incompat_flags(p) & MAVFRAME_IFLAG_SIGNED) != 0;
}
/* 13 signature bytes (link id, 48-bit timestamp, 48-bit hash), or NULL if the
 * frame is not signed. The signature is carried, not verified. */
static inline const uint8_t *mavframe_signature(const mavframe_parser *p)
{
    return mavframe_signed(p)
               ? mavframe_payload(p) + mavframe_payload_len(p) + MAVFRAME_CRC_LEN
               : NULL;
}
/* Total length of the current frame in bytes, including signature. */
static inline uint16_t mavframe_frame_len(const mavframe_parser *p)
{
    return (uint16_t)(MAVFRAME_HEADER_LEN + mavframe_payload_len(p) + MAVFRAME_CRC_LEN +
                      (mavframe_signed(p) ? MAVFRAME_SIGNATURE_LEN : 0));
}
/* Bytes held in the buffer, including the frame just reported. The stream
 * offset of the current frame is (bytes fed so far) - mavframe_pending(). */
static inline uint16_t mavframe_pending(const mavframe_parser *p)
{
    return (uint16_t)(p->tail - p->head);
}
static inline const mavframe_stats *mavframe_get_stats(const mavframe_parser *p) { return &p->stats; }

#ifdef __cplusplus
}
#endif

#endif /* MAVFRAME_H */
