# Failure modes and recovery

| Condition | Behavior | User recovery |
|---|---|---|
| Empty, truncated or noisy capture | Native parser rejects or retains incomplete framing; no fabricated valid packets | Confirm raw/tlog format and inspect the original with the native CLI |
| CRC mismatch | Failure is attached to a candidate frame and its byte offsets | Compare the original; mutating a copy never overwrites it |
| Unknown message or incompatible flags | Unsupported/header-only finding; no invented field decode or established payload boundary | Regenerate definitions for a reviewed dialect or use the correct protocol |
| Reordered, reset or merged sender stream | Sequence estimate can differ from actual RF loss | Inspect timeline and recording topology; do not treat the estimate as measured loss |
| Reversed/missing record clock | Unreliable rate/duration omitted | Use a trusted clock source outside this tool |
| File exceeds 256 MiB or report exceeds 64 MiB | Explicit bounded rejection | Split input or use the native tool |
| Browser memory pressure | Tab may be terminated by the browser | Use smaller captures; keep the original on disk |
| Device disconnect or session cap | Stop, release worker/port and retain the last byte snapshot when the parser responds | Inspect the retained 8 MiB tail before a new session or page close |
| Parser worker crash or timeout | Stop and show the reason; a failed worker may not return its byte snapshot | The unsaved tail may be lost; reconnect or inspect a separately recorded file |
| Serial API missing | File inspector remains usable; live capture is unavailable | Use a compatible secure-context browser or record to a local file |
| Offline with no prior installation | Public assets are unavailable | Load online once; no private capture is needed for installation |
| Old service-worker cache | Existing tab may use its previous release | Close old tabs and reload; never clear private files to update the app |

Before release run native C/Python tests, ASan/UBSan, native/Wasm differential
tests, generated-artifact checks and the browser suites. Review both themes at
320/768/1440, keyboard focus, export contents and unexpected console/CSP errors.
The browser's 1,000-call fuzz action is a diagnostic demonstration; CI also runs
bounded libFuzzer campaigns. Neither substitutes for an ongoing security review.

There is no server `/healthz` or `/metrics`: no server exists in this deployment.
Report repeatable defects with the tool revision and a minimal synthetic input.
Public issue reports must not contain private flight logs or device identifiers.
