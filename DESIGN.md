---
version: 1
name: mavframe inspector
extends: docs/css/ui.css   # shared base; only what docs/css/inspector.css adds or overrides is listed
dial: ENERGY 1 / RHYTHM 1 / MOTION 1
colors:
  density:  { light: "#818b98", dark: "#656c76", use: "timeline frames-per-interval bars and their legend glyph", src: "inspector.css:2,4" }
  seg-ts:   { light: "#eef1f4", dark: "#21262d", use: "hex tint, tlog timestamp bytes (paired with a dotted underline)", src: "inspector.css:2,4" }
  seg-hdr:  { light: "#e8f0fe", dark: "#121d2f", use: "hex tint, frame header bytes (paired with a solid underline)", src: "inspector.css:2,4" }
  seg-pay:  { light: "#ffffff", dark: "#0d1117", use: "hex tint, payload bytes (the unmarked region)", src: "inspector.css:2,4" }
  seg-crc:  { light: "#fff8c5", dark: "#272115", use: "hex tint, CRC bytes (paired with a double underline)", src: "inspector.css:2,4" }
  seg-sig:  { light: "#dafbe1", dark: "#122117", use: "hex tint, signature bytes (paired with a dashed underline)", src: "inspector.css:2,4" }
  # Everything else (bg, bg-subtle, fg, fg-muted, border, border-strong, accent, ok, warn, bad and their -subtle
  # variants) is the shared baseline in docs/css/ui.css:6-17.
contrast:   # WCAG relative luminance, computed from the hex values above and in ui.css
  - { fg: density,   bg: bg,          light: 3.45, dark: 3.57, need: 3.0, what: "timeline bars (was #afb8c1 / #484f58: 2.01 / 2.28)" }
  - { fg: density,   bg: bg-subtle,   light: 3.24, dark: 3.26, need: 3.0, what: "legend glyph in the box header" }
  - { fg: fg-muted,  bg: seg-ts,      light: 5.39, dark: 5.23, need: 3.0, what: "timestamp dotted underline" }
  - { fg: accent,    bg: seg-hdr,     light: 5.57, dark: 5.45, need: 3.0, what: "header solid underline" }
  - { fg: warn,      bg: seg-crc,     light: 4.52, dark: 6.33, need: 3.0, what: "CRC double underline" }
  - { fg: ok,        bg: seg-sig,     light: 4.56, dark: 6.58, need: 3.0, what: "signature dashed underline" }
  - { fg: accent,    bg: bg,          light: 6.39, dark: 6.11, need: 3.0, what: "header underline against the page under the tint" }
  - { fg: warn,      bg: bg,          light: 4.87, dark: 7.50, need: 3.0, what: "CRC underline against the page" }
  - { fg: ok,        bg: bg,          light: 5.08, dark: 7.45, need: 3.0, what: "signature underline against the page" }
  - { fg: fg,        bg: seg-ts,      light: 13.93, dark: 12.88, need: 4.5, what: "hex text on the darkest tint" }
  - { fg: fg,        bg: seg-crc,     light: 14.66, dark: 13.52, need: 4.5, what: "hex text on the CRC tint" }
  - { fg: seg-ts,    bg: bg,          light: 1.13, dark: 1.24, need: none, what: "tints against the page: decorative only, the underline carries the meaning" }
  - { fg: accent-fg, bg: accent,      light: 6.39, dark: 6.11, need: 4.5, what: "primary and pressed buttons" }
  - { fg: bad,       bg: bg,          light: 5.36, dark: 5.65, need: 4.5, what: "CRC error counts and labels" }
  - { fg: warn,      bg: bg,          light: 4.87, dark: 7.50, need: 4.5, what: "sequence gap counts and labels" }
  - { fg: fg-muted,  bg: bg-subtle,   light: 5.74, dark: 5.94, need: 4.5, what: "legend text, table headers" }
typography:
  ui:   { family: "Atkinson Hyperlegible", root: "93.75% (15px at the default 16px; follows the browser setting)", lineHeight: 1.5 }
  mono: { family: "ui-monospace,SFMono-Regular,Menlo,Consolas,Liberation Mono,monospace", use: "hex dump, offsets, file name, axis labels, numeric table cells (td.num), decoded values" }
  scale: { h1: 1.05rem, h2: .95rem, h3: .9rem, metric: 1.15rem, body: 1rem, table: .92em, small: .85em, min: "12px (.8rem axis and metric notes)" }
spacing: [2, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24]
rounded: { byte: "2px 2px 0 0", md: 6px, label: 2em }   # 2em only on the shared .label ("Synthetic sample")
elevation: { page: flat, boxes: "1px border, no shadow" }
motion:
  default: none
  allowed: [{ name: ".btn colour change", property: "background-color, border-color", duration: 120ms, iterations: 1, reduce: off, src: "ui.css:40" }]
components:
  btn:          { base: "ui.css:23-27", radius: md, minTarget: "32px high", states: [hover, active, focus-visible, disabled, aria-pressed] }
  view-toggle:  { base: "ui.css .btn[aria-pressed]", markup: "index.html #view-frames/#view-issues in .toggles", states: [pressed, unpressed, focus-visible, disabled] }
  repo-link:    { base: "ui.css:38 .app-header .repo", states: [default, focus-visible] }
  metrics:      { base: "inspector.css:35-41", note: "seven cells of one strip; CRC errors, Sequence gaps, Skipped bytes first" }
  timeline:     { base: "inspector.css:64-75", marks: "bars (density), CRC triangle (bad), gap square (warn), dashed line (other), cursor (accent)" }
  table-dense:  { base: "ui.css:31-32 + inspector.css:83-88", numeric: "td.num right-aligned, monospace, tabular-nums; all th in the UI face" }
  rowbtn:       { base: "inspector.css:90-93", radius: md, minTarget: "24x24", states: [hover, focus-visible, aria-pressed, aria-current] }
  hex-dump:     { base: "inspector.css:107-118", regions: "tint + underline pattern + visually hidden region name before the first byte" }
  note:         { base: "inspector.css:124", states: [default] }
  label:        { base: "ui.css:29-30", use: "Synthetic sample warning only" }
---

# mavframe inspector design

## Overview
One screen that answers "is this MAVLink capture healthy, and where is it not?". The focal point is the issue count (CRC errors, Sequence gaps, Skipped bytes, shown first in the summary strip) and the timeline that places each issue in time; the frame list, hex dump and decoded pane are the evidence for the selected issue. The page opens with the bundled synthetic sample already parsed, so the first screen is never empty.

## Colors
The app uses the shared neutral scale and one accent from `docs/css/ui.css`; it adds two kinds of tokens.

- `--density` (bars of frames per interval) is a meaningful graphic, so it must reach 3:1. It reuses the `border-strong` values (#818b98 / #656c76): 3.45:1 / 3.57:1 on the timeline, 3.24:1 / 3.26:1 on the legend row. Earlier values (#afb8c1 / #484f58) were 2.01:1 / 2.28:1.
- `--seg-*` tint the five byte regions of a frame. The tints are about 1.1:1 against each other and the page, which is too little to carry meaning, so they are decoration and each region also carries an underline pattern in a status or accent colour (table above, every mark 3:1 or more against both its tint and the page). Payload is the region without an underline.
- Status colours appear only with a word: "CRC error", "Sequence gap", a labelled count, or the timeline legend glyph shape (triangle, square, dashed line).

## Typography
Atkinson Hyperlegible for all UI text, including table headers and summary numbers (`font-variant-numeric: tabular-nums`). Monospace is reserved for bytes, offsets, IDs, the file name, axis labels and numeric table cells, where column alignment matters. The root size is `93.75%`, so the browser's default text size is respected.

## Layout
- Header, toolbar, status line, summary strip, timeline box, then two split panes (Messages | Frames) and (Bytes | Decoded).
- Breakpoints: `max-width: 900px` stacks both pane rows into one column; `max-width: 560px` makes the summary two columns, hides the tagline and shows "Scroll the table sideways for senders".
- Scrolling regions: the frame list (`.list-wrap`, max 420px, sticky header), the messages table (sideways on narrow screens), the hex dump and the decoded pane. The page itself never scrolls sideways at 320px.

## Elevation and shapes
Flat. Boxes use a 1px `--border` and the shared 6px radius. Hex bytes use a 2px top radius only, so the underline pattern meets a straight edge.

## Motion
None by default. Under `prefers-reduced-motion: no-preference`, `.btn` colours change over 120ms (one transition, never looping). Under `reduce`, ui.css turns all transitions and animations off. Nothing else moves.

## Components
- **Buttons** (`.btn`): default, hover (bg-inset), active, focus-visible (2px accent ring), disabled (55% opacity, not-allowed cursor). `.btn.primary` ("Load sample flight") darkens on hover and press.
- **View toggles** "All frames" / "Issues (n)": `.btn` with `aria-pressed`; pressed is the accent fill with the accent-fg text (6.39:1 / 6.11:1). Same radius and height as every other button.
- **Source on GitHub**: `.app-header .repo`, an underlined accent link like every other link on the page.
- **Row buttons** (`.rowbtn`): row number in the frame list and message name in the messages table; selected rows use `aria-current` or `aria-pressed`, bold text and the selected-row background.
- **Selected row**: accent-subtle background plus a 3px accent inset on the left. Reason for the stripe: it is the one place the timeline cursor, hex dump and decoded pane all point to, and the row number also turns bold, so the state is not carried by colour alone.
- **Hex dump**: per byte, the region tint, the underline pattern and a mouse `title`; before the first byte of each region, a visually hidden name ("header: ", "CRC: ") for screen readers.
- **Notes** in the decoded pane: bordered boxes on bg-subtle; the lead sentence above them states the issue kind in words.

## States
- Empty: before any capture, "Select a frame." in the hex pane and "Select a frame or an issue." in the decoded pane; "No issues: every frame passed its CRC and no sequence numbers were skipped." in the issue list.
- Loading: one `role="status"` line ("Loading sample-flight.tlog…", then the result sentence), a determinate `<progress>` for large files and a Cancel button.
- Error: the status line in the bad colour and bold, with the cause and the next step (empty file, not MAVLink, too large, network failure).
- No JavaScript: a `<noscript>` paragraph on warn-subtle explains why nothing works and names the command-line alternative.

## Do and don't
- Do pair every status colour with a word or a glyph shape; do measure any new tint or mark before adding it here.
- Do keep monospace for bytes and aligned numbers only; headers and summary values stay in the UI face.
- Don't add a second accent, pills other than the shared `.label`, or a looping animation for "live" parsing.

## Known gaps
- Copying text from the hex dump also copies the visually hidden region names ("header: ").
- The messages table header is `position: sticky`, but its container only scrolls sideways, so the header never actually sticks there (it does in the frame list).
- Region names in the hex dump have only been checked with automated tests (axe-core and Playwright); a manual screen-reader check has not been run.
