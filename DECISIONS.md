# Decisions

## One C parser for native and browser use

Use the existing allocation-free C99 framing/CRC code compiled to Wasm rather than
a second JavaScript implementation. Differential tests compare native and Wasm
outputs on the same corpus. Payload display and sequence estimates stay outside
the framing API. This preserves a small embedded library while making the browser
useful; it does not establish correctness for all byte strings.

## Pinned common and ArduPilot definitions

Vendor the official XML include graph at the revision recorded in
`tools/mavlink-xml/SHA256SUMS`. Generate the CRC table and browser field metadata,
then compare them with pymavlink generated from the same snapshot. This avoids
comparing a newer XML revision against older prebuilt pymavlink dialects.
Custom dialects require a reviewed regeneration; unknown IDs remain unsupported.

## Bounded local tools, no capture service

Keep the existing vanilla-JS inspector and add native workers for live capture
and finite fuzz batches. A bounded tail makes live memory use predictable but
cannot preserve an entire long session. A local file remains memory-backed.
The browser asks for a port only after the user's explicit Connect action.
No writes are sent to the serial device. Hardware integration remains unverified.

## Evidence and diagnostic uncertainty

Sequence gaps estimate missing frames only under the documented single-channel,
in-order assumptions. An unknown header can account for an exact next sequence
without becoming an accepted frame; its identity is still untrusted. Clock
reversals suppress misleading rates. Export omits payload bytes by default.

## Keep MIT licensing and separate services

The repository remains MIT, including commercial use. Do not introduce AGPL or
claim buyers need a paid binary licence. The support dialog describes proposed
custom-dialect/integration work, with no active checkout or email collection.
Third-party definitions, icons and fonts retain their own notices.
