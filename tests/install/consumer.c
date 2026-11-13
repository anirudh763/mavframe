#include <mavframe.h>
#include <stdio.h>
static const uint8_t check[] = "123456789"; /* CRC-16/MCRF4XX known answer: 0x6F91 */
int main(void) { mavframe_parser p; mavframe_init(&p); uint16_t crc = mavframe_crc16(MAVFRAME_CRC_INIT, check, 9);
    printf("mavframe %s crc=0x%04X\n", MAVFRAME_VERSION_STRING, (unsigned)crc); return crc != 0x6F91 || mavframe_get_stats(&p)->bytes != 0; }
