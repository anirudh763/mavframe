/*
 * Minimal <string.h> for the wasm32-freestanding build of mavframe.
 * There is no libc on that target; the four functions src/mavframe.c uses
 * are implemented in web/wasm/mavframe_wasm.c. Not used by native builds.
 */
#ifndef MAVFRAME_WASM_STRING_H
#define MAVFRAME_WASM_STRING_H

#include <stddef.h>

void *memcpy(void *dst, const void *src, size_t n);
void *memmove(void *dst, const void *src, size_t n);
void *memset(void *dst, int c, size_t n);
void *memchr(const void *s, int c, size_t n);

#endif
