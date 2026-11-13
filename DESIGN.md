---
version: 2
name: Mavframe inspector
supersedes: "version 1 (dark-first, single page); replaced by the root-approved light system of 2026-11-13"
files: { base: docs/css/ui.css, app: docs/css/inspector.css, theme-before-paint: docs/js/theme.js }
dial: ENERGY 1 / RHYTHM 2 / MOTION 1
theme: { default: light, dark: "opt-in only, via the labelled 'Dark theme' toggle (aria-pressed), remembered in localStorage inside try/catch; never from prefers-color-scheme" }
colors:   # light / dark (dark values are only used after the explicit choice)
  canvas:   { light: "#f7f8fa", dark: "#0f1720", use: "page background" }
  surface:  { light: "#ffffff", dark: "#16202b", use: "location header, tables, panes, inputs" }
  rail:     { light: "#f0f3f5", dark: "#121b24", use: "left rail / menu sheet, table header cells" }
  ink:      { light: "#152536", dark: "#e4ebf2", use: "text" }
  muted:    { light: "#4b5e6f", dark: "#a6b4c2", use: "secondary text, legends, hex offsets" }
  input:    { light: "#748694", dark: "#7f909f", use: "control boundaries (>= 3:1)" }
  divider:  { light: "#dce2e8", dark: "#2c3a48", use: "1px borders" }
  primary:  { light: "#005a9c", dark: "#7cbdf2", use: "links, primary action, current nav item, selected field bytes" }
  positive: { light: "#12633c", dark: "#6fd19a", use: "'Valid CRC' (always with text)" }
  warning:  { light: "#925400", dark: "#e9b064", use: "sequence notes, CRC byte underline (always with text)" }
  danger:   { light: "#b42318", dark: "#ff9b8f", use: "'CRC failed' (always with text)" }
  hex-tints: { seg-ts: "#eef1f4", seg-hdr: "#e5eff7", seg-pay: "#ffffff", seg-crc: "#fcf1dd", seg-sig: "#e3f2e9", note: "decorative; each region also has its own underline pattern (dotted / solid / none / double / dashed)" }
typography:
  ui: { family: "Atkinson Hyperlegible (local woff2, SIL OFL 1.1)", body: "16px / 1.5", h1: "30px / 1.2 (26px under 600px)", h2: "20px", numbers: "tabular-nums" }
  mono: { family: "system monospace", size: 14px, use: "ONLY hex bytes, byte offsets, CRC/hash values, code" }
spacing: [4, 8, 16, 24, 32]
controls: { min-target: 44px, radius: 7px, focus: "2px primary outline, 2px offset" }
elevation: "flat: 1px divider borders, no shadows, no gradients"
layout:
  desktop: ">= 1000px: 216px rail (wordmark 'Mavframe', purpose line, 'Inspect' group: Capture, Frames; 'Learn' group: Format help; theme toggle and source link at the foot) + white location header (← Back on contextual screens, breadcrumb 'Mavframe / Screen') + workspace with 32px gutter, content max 1100px"
  intermediate: "< 1000px: no permanent rail; a labelled Menu button opens the rail as a modal sheet (focus kept inside, Escape closes, focus returns to Menu)"
  mobile: "< 600px: 16px gutter"
---

# Mavframe inspector design

## Signature pattern: packet analyzer

The inspector is a Wireshark-style packet analyzer over the real parser output, with three linked views:

1. **Frame list**: one row per valid frame and per rejected candidate (CRC failed, unsupported id, bad flags), in byte order.
   Columns: Check, Message, Time (s), Offset, Sys:Comp, Seq, Note (Check first so a CRC failure is visible at 320px). Filters are chips (All, Issues, CRC failed, Unsupported,
   Valid CRC) and a Message select; the filter, page and selection are in the URL.
2. **Field tree**: the selected row's tlog timestamp, header fields, decoded payload fields, CRC and signature, each a button
   with its byte range.
3. **Bytes**: hex and ASCII, regions tinted and underlined.

Selection is linked both ways: a field highlights its bytes, a click on a byte selects its field, and with the bytes focused
Left/Right move between fields (the keyboard path). The CRC wire and computed values sit side by side above the panes.

- Where the analyzer is usable, `(min-width: 1200px) and (min-height: 880px)`, the Frames screen fills the viewport
  height with no page scrolling. The left column holds the heading, counts, assumption line, timeline, filters and the
  scrolling frame list. The right column, at full height, holds CRC wire vs computed, the field tree (header fields
  first: all 8 fit without inner scrolling) and the bytes (room for 8 rows), then Export. `#/frames/<index>` selects a
  row on this screen: title, H1 and breadcrumb stay "Frames", with no Back link. Selecting a row keeps keyboard focus in
  the list, and arrow keys move the selection. The threshold was measured: the 8 header rows (44px targets), 8 hex rows,
  the CRC row and Export need about 820px below the location header.
- Below that size (for example 1024x768 or 1280x720) Frames and Frame details are two steps, as on narrow screens:
  `#/frames/<index>` is the Frame details screen with Back, title "Frame details" and Decoded / Bytes / Header tabs.
- The hex pane shows 16 bytes per row and falls back to 8 or 4 when a row (with its ASCII column) does not fit.
- Elsewhere the same URL is its own **Frame details** screen with **Decoded / Bytes / Header** tabs (ARIA tabs, arrow keys).

Reference: Wireshark User's Guide, "Working With Captured Packets"
(https://www.wireshark.org/docs/wsug_html_chunked/ChapterWork.html): "Clicking on an item in the tree will highlight the
corresponding bytes in the byte view."

## Routes

| Route | Screen |
|---|---|
| `#/capture` (default) | Open a file or the engineering sample; summary, assumptions, message types |
| `#/frames?check=&msg=&page=` | Timeline, filters, frame list (and the analyzer panes on wide screens) |
| `#/frames/<index>?tab=&f=` | Frame details (contextual; not in the global nav) |
| `#/help` | Format help |
| anything else under `#/` | Not found, with a link to Capture |

Old single-page links (`#view=issues&msg=30&sel=f12`) are mapped to these routes. Every route change sets
`document.title` to "Screen – Mavframe" for the screen actually shown (Frames on wide screens, Frame details on narrow
ones), updates the breadcrumb and `aria-current`, and moves focus to the new screen's H1 (tabindex=-1, no outline).
Selecting a row on the same wide screen keeps focus on the row instead.

## Targets and type

- Every interactive element is at least 44 x 44 px (nav links, wordmark, Back, Menu, theme toggle, chips, selects, tabs,
  row links, field buttons, pager, export button and the checkbox's label). Links inside sentences are the WCAG 2.5.8
  inline exception. `tests/web/test_routes.mjs` measures all of them on every screen at 320 and 1440px and proves the
  check fails when nav links, tabs and Menu are shrunk to 24px.
- Monospace only for hex bytes, byte offsets and hex values (CRC, flags); decimal field values use the UI face. Text
  wraps at word boundaries; only monospace hex values may break anywhere.

## Honesty in the UI

- CRC failed (checksum mismatch) and Unsupported (not checked) are separate checks, separate filters and separate words.
- "signature present; not verified" wherever a signed frame appears.
- Sequence gaps always carry the one-fully-observed-channel, in-order-arrival assumption.
- The bundled sample is labelled an engineering fixture, not a real flight, on Capture and Frames.
- The finding export leaves out payload bytes of any message that may carry position unless the user opts in.

## States

Every data screen has loading ("Parsing the capture…"), empty ("No capture is loaded yet" + Go to Capture), no-match
("No rows match these filters" + Clear filters), out-of-range row and error (status line, `role=status`) states.

## Gates

`tests/web/test_routes.mjs` (root visual gate, analyzer, export), `tests/web/test_ui.mjs` (behaviour, contrast) and
`tests/web/test_finding.mjs` (row model and export) must pass.

## Rules applied from the reference repos

- ui-ux-pro-max-skill `src/ui-ux-pro-max/templates/base/quick-reference.md`: line 88 `touch-target-size` (44 px), line 69
  `color-not-only` (every status has text), line 53 navigation (predictable Back, deep linking).
- anti-slop `skills/antislop-ui/SKILL.md` lines 20-25 (no default gradients) and 39-43 (shadow only as an elevation marker:
  this UI is flat); `skills/antislop-layoutmobile/SKILL.md` lines 41-42 (design the 600-1024px band: Menu sheet below
  1000px, two-step route layout tested at 1024x768 and 1280x720).
- awesome-design-md: token front matter plus prose order for this file; `design-md/linear.app/DESIGN.md` line 264 (mono
  reserved for code) informs the mono-only-for-hex rule. axe-core: 0 violations on every screen, light and dark,
at 1280 and 320 px.
