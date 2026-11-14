---
version: 3
name: Mavframe packet bench
supersedes: "version 2 shared 216px rail; independent composition selected 2026-11-13"
files: { base: docs/css/ui.css, app: docs/css/inspector.css, theme-before-paint: docs/js/theme.js }
dial: ENERGY 2 / RHYTHM 2 / MOTION 1
theme: { default: light, dark: "explicit, remembered 'Dark theme' toggle; never inferred from OS preference" }
colors:
  canvas: { light: "#f6f5f2", dark: "#1c1b26", use: "porcelain work surface" }
  surface: { light: "#ffffff", dark: "#252430", use: "opaque packet panes and commands" }
  rail: { light: "#eeece7", dark: "#2e2d3a", use: "table headers, status strip, narrow command menu" }
  ink: { light: "#25243a", dark: "#f2efea", use: "graphite text and frame-list heading" }
  muted: { light: "#595766", dark: "#c1bbc7", use: "secondary text and byte offsets" }
  input: { light: "#807c80", dark: "#928c98", use: "control boundaries" }
  divider: { light: "#d8d4cd", dark: "#4e4956", use: "data and pane separators" }
  primary: { light: "#9a4300", dark: "#ffb67c", use: "burnt-orange action, current route and linked field selection" }
  positive: { light: "#246043", dark: "#8ad4a8", use: "Valid CRC, always named" }
  warning: { light: "#855000", dark: "#f0c478", use: "sequence assumptions and CRC-region mark" }
  danger: { light: "#ae2823", dark: "#ffaaa2", use: "CRC failed, always named" }
typography:
  ui: { family: "system-ui, platform sans-serif", body: "16px / 1.5", h1: "28px / 1.2; 26px on phone", use: "commands, headings and prose" }
  mono: { family: "system monospace", size: 14px, use: "packet field names, bytes, byte offsets, hex values, IDs and code" }
controls: { target: "44 x 44px", radius: 4px, focus: "2px primary outline plus 2px offset" }
elevation: "opaque flat surfaces, no decorative shadows, gradients, blur or animation"
---

# Packet bench

The design read is a dense instrument for examining linked packet representations. Horizontal commands keep the entire
desktop width available to captures. Porcelain separates the working area from white data surfaces; graphite gives the
frame-list heading a clear anchor in grayscale. Burnt orange identifies actions and the current selection. It is separate
from the red, green and amber state colors, which always include words or region patterns. System sans keeps controls and
explanations readable; monospace gives fields and byte positions a stable alignment. ENERGY 2 / RHYTHM 2 / MOTION 1:
the selected packet is the focal point, with no entrance animation or decorative assets.

The UI/UX design search in `Downloads/active/design-searches/Mavframe-narrow.md` supports a data-dense dashboard style.
Its enterprise gateway/marketing composition, blue palette and remote font suggestions are rejected. The council's
capture command bar and linked packet bench determine composition, palette and type.

## Composition and reflow

- Desktop commands form one compact horizontal masthead: wordmark and purpose, Capture / Frames / Format help, explicit
  theme choice and source link. There is one page banner. Location and Back are a labelled region, without a second banner.
- Capture begins with the real horizontal file/sample/format command bar and an adjoining status/progress strip. The
  loaded capture follows as a source line, numeric summary, qualified assumptions and a message-type table. Counts come
  from the parser; the sample is labelled synthetic and never presented as a real flight.
- At `(min-width: 1200px) and (min-height: 880px)`, Frames fills the available desktop height. The left column contains
  heading, qualified capture counts, timeline, filters and independently scrolling frame rows. The right column contains
  CRC wire/computed/result, the independently scrolling field tree, bytes and payload-opt-in export. The existing
  threshold and route adaptation remain unchanged. The masthead replaces the old sidebar; the redundant location line
  is visually hidden on this screen, while its breadcrumb remains available to assistive technology.
- At 1440x900, eight 44px header field targets, room for at least eight byte rows, frame rows and Export fit in the
  viewport. Header fields come first in the tree. Notes, timestamp, CRC and payload fields remain reachable by pane scroll.
- Smaller or shorter displays keep Frames and Frame details as two steps. Details has Decoded / Bytes / Header tabs.
  The intermediate 600–999px range uses a compact Menu and contextual details, rather than a squeezed analyzer.
- Below 1000px the labelled Menu opens the existing modal command sheet: focus stays inside, Escape closes it, and
  focus returns to Menu. At 320px the controls wrap, metrics use two columns and wide tables scroll only in their named
  regions. At 768px the summary expands naturally. Hex adapts from 16 to 8 or 4 bytes per row including ASCII.

## Routes and interaction

| Route | Screen |
|---|---|
| `#/capture` | Open a file or the engineering sample; summary and message types |
| `#/frames?check=&msg=&page=` | Timeline, filters and frame list; analyzer when it fits |
| `#/frames/<index>?tab=&f=` | Selected frame in the wide analyzer; contextual Details otherwise |
| `#/help` | Format help |
| other `#/` paths | Not found, with Capture link |

Legacy `#view=issues&msg=30&sel=f12` links still map into these routes. Route, title, H1, breadcrumb and current navigation
agree. Back preserves filters. Wide row selection keeps list focus, ArrowUp/Down moves the selection, selecting a field
highlights its byte range, and clicking a byte selects its field. Left/Right in the bytes provide the keyboard equivalent.
Selection, filter and tab state remain in the URL. No parser, analysis or export logic belongs in visual styling.

## Accessibility and truthful states

Normal text needs 4.5:1 and focus/control boundaries need 3:1. Targets stay at least 44px, including nav, filters, field
buttons, tabs, pager, export and the checkbox label. Prose links use the inline exception. Focus remains visible;
200% text/zoom reflows and the root font follows the browser's default. Reduced-motion users get no transitions.

Every data screen retains loading, empty, no-match, error and out-of-range selection states. Progress and cancellation
use existing status announcements. Unsupported IDs are not CRC failures. Signatures are present but not verified.
Sequence-gap estimates carry the fully-observed-channel and in-order-arrival assumptions; they do not establish radio loss.
The AI-assistance disclosure stays visible in Format help.

JSON exports omit all raw payloads unless the user explicitly opts in, including familiar message IDs and damaged headers.
Header-only unsupported/bad-flags candidates export neither payload nor an inferred CRC. A visual change must not change
this boundary or the cancellation race fix. The C source, headers, Wasm, analysis core, generated definitions and sample
capture remain byte-identical.

## Verification

Existing `test_finding.mjs`, `test_routes.mjs` and `test_ui.mjs` cover row and export behavior, real route transitions,
linked selection, 44px targets (including deliberate shrink sabotage), theme persistence, both-theme contrast and axe.
Only the obsolete 216px rail and blue-palette assertions change for version 3. Desktop, 768px and 320px screenshots,
including grayscale silhouettes, are inspected in `Downloads/active/mavframe-packet-bench-evidence`.
