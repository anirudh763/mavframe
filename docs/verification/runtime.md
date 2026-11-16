# Mavframe HTTP runtime verification

The repository's `tools/http_server.py` serves the built public files and the process health/metrics endpoints. The focused regression suite uses temporary synthetic document roots and loopback connections; it needs no browser, application build, native engine, database or credentials.

## Reproduce the focused checks

Use a POSIX environment with Python 3.13 and pip. From the repository root:

```sh
python3.13 -m venv /tmp/mavframe-http-checks
source /tmp/mavframe-http-checks/bin/activate
python -m pip install -r requirements-web.txt pytest
python -m pytest -q tests/http_server_regression.py
```

The explicit test filename keeps this HTTP-only dependency boundary separate from the native/data suites' default discovery. The existing [workflow](../../.github/workflows/ci.yml) contains an independent `http-runtime` job with Python 3.13, the same requirements file and this exact pytest command. Existing checkout/setup action pins are retained. This job has been added locally; no remote CI execution is claimed here.

## Observed result

Local working-tree verification on 2026-11-15 passed **25 tests and 9 subtests**, with Python 3.13.1, pytest 9.2.0 and prometheus-client 0.26.0. All 25 canonical test bodies and their 116 assertion call sites are preserved; only the import location is adapted to `tools/http_server.py`.

The cases cover exact route fallback and missing API/assets; legacy directory indexes without listing; MIME/security headers; liveness versus critical-asset readiness; real HTTP metrics; redaction of query/authorization values; symlink and swap-at-open escapes; file-descriptor ownership; malformed/overlong requests; overload and unsupported-method accounting; HEAD; bounded shutdown and response draining; partial reads/writes/disconnects; and zero-byte connections. All four supported application profiles are exercised using synthetic fixtures.

These are finite HTTP runtime checks. They do not establish domain-engine correctness, application browser workflows, full accessibility conformance, container hardening or production load capacity. Local raw run logs, private captures and credential files are not publication inputs.

## Serve this application

Prepare the public files using the existing [application quickstart](../../README.md), then use the activated environment above:

```sh
python tools/http_server.py --root docs --app mavframe --host 127.0.0.1 --port 3003
```

Open [the local application](http://127.0.0.1:3003/). Stop a foreground server with Ctrl-C. Process metrics describe the HTTP server; browser operations and domain validity require their separate tests. Readiness verifies critical local assets without changing them.
