# Mavframe server workspaces

The static Pages build still runs without a backend. The optional Python HTTP image adds private saved work and accounts; it does not move domain computation to the server.

## Standalone local launch

Keep the five-app Compose deployment if it is already running. For a standalone checkout, first copy `.env.example` to an ignored `.env` **only if that file does not exist**. Set a stable random `APP_SESSION_SECRET` (at least32bytes), preserve it across restarts, and retain the documented loopback origin on port3003. Never put the secret in a frontend variable or commit it.

```sh
docker build -f Dockerfile.web -t mavframe-local .
docker run -d --name mavframe-local --read-only --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m --env-file .env \
  --mount type=volume,source=mavframe-workspaces,target=/var/lib/product \
  -p 127.0.0.1:3003:8080 mavframe-local
# Stop or restart just this standalone instance, retaining its volume:
docker stop mavframe-local
docker start mavframe-local
```

The selected port must be free; do not stop another application to claim it. For HTTPS, set the exact HTTPS origin and `APP_LOCAL_HTTP=0`; use a separate hostname for each app. `/healthz` checks process liveness, `/readyz` checks required storage/session readiness, and `/metrics` reports HTTP activity, not domain accuracy.


The same bounded persistence protocol is used by the four browser products. This repository’s checks are recorded under artifacts/verification/canonical-persistence-20261116. The separate LeaseQ engine is unchanged.

Each app runs its existing static HTTP runtime plus SQLite WAL, Beaker server-side sessions and Argon2id optional accounts. It has a separate named volume, cookie name, session signing secret, SQLite database and artifact/snapshot tree. A single process serializes mutations with a lock and BEGIN IMMEDIATE; no multi-host or unlimited-concurrency guarantee is made. Existing browser domain engines compute the results, explicitly saved as `browser-computed`. The server validates and authorizes persistence; it does not certify that a submitted result ran an engine.

## Configuration and deployment

APP_DATA_DIR points outside public assets; local Compose uses /var/lib/product owned UID/GID10001, mode0700, with a read-only container root. APP_SESSION_SECRET is stable, random, at least32bytes. Keep local environment files mode0600 and out of Git. The separate five-app workspace also provides create_launch_env.py for creating its four app files without overwriting them. APP_PUBLIC_ORIGIN is an exact origin. APP_LOCAL_HTTP=1 accepts only explicit loopback HTTP for development; HTTPS produces Secure cookies. APP_SESSION_TTL_SECONDS defaults30days. APP_PASSWORD_AUTH=1 enables local server accounts with no external identity verification or email recovery.

Cookie identifiers are opaque, HttpOnly, SameSite=Lax, explicitly expiring and durable. Registry expiry/revocation is checked on every request, and authentication rotates the session. POST/PUT/PATCH/DELETE require exact Origin and CSRF, except the narrowly scoped initial guest bootstrap. No credentialed wildcard CORS or forwarded-header trust. Apps on the same loopback host use different cookie names; production should use separate HTTPS hostnames because browser cookies are not scoped by port.

Build-time prepare_persistence_assets.py marks public HTML and updates its exact offline integrity digest. Browser-only repository assets remain unmarked. Browser persistence requests and saved-artifact downloads have a30second deadline; failed saves retain input for explicit retry. Uploads require explicit Save current run; reconnect only announces pending changes and never starts an upload. Private API routes are network-only and no-store; offline domain editing continues with unsynced work retained, rather than pretending server storage is available.

## Contracts and bounds

POST /api/session/guest automatically creates or resumes an owned guest workspace. GET /api/session returns current session and CSRF; signup/login rotate and safely transfer authorized guest work; logout revokes. No user-supplied workspace ID alone grants access.

/api/workspaces stores versioned metadata; /api/runs stores domain payloads and artifact references; /api/exports stores actual persisted-run JSON/Markdown/CSV; /api/sync stores completed or failed owned logical snapshots and restores into a new workspace. Lists use limit/offset (at most50 records). Existing browser-specific PDF, JSONL and Parquet exports remain supported by their real implementations. Public /api/samples contains current verified source hashes; existing workspace provenance is not rewritten when a source changes.

Metadata requests64KiB, depth16,10000nodes; Warehouse JSON source artifacts retain the existing2MiB import limit with220000 bounded nodes (2000 × 100 scalar fields plus containers), with the same nested credential/private-JWK/PEM checks; other JSON artifacts remain64KiB; artifacts32MiB each; one large in-flight upload; artifact and snapshot budgets256MiB each; persisted metadata64MiB; at most1000 active guest sessions. Rates are bounded by the implementation (30 guest bootstraps/minute/IP,10 auth attempts/minute/IP,120 mutations and600 reads per minute). Over-limit responses are explicit; no automatic deletion of user records is performed. Private-key PEM/JWK and credential fields are rejected, including encoded JSON artifacts.

Snapshots are consistent workspace-owned logical copies, including actual artifact bytes, placed in SQLite staging and written using sqlite3.backup and atomic files. They exclude auth/session databases and private signing keys. SHA-256 and schema/reference checks precede restore; restore remaps identifiers into a new workspace and leaves the original intact. Snapshots share the local volume and are not a separate device backup. The32MiB serialized logical snapshot limit includes base64 expansion; a large source may save successfully but exceed snapshot capacity. Export source files separately before relying on this bounded local backup. Failed snapshots remain visibly failed, with originals unchanged.

Versioned SQL migrations apply transactionally; source seeding is idempotent. Current database, sessions and source files survive restart and recreation through the named volume. Retain the volume and stable secret together. Back up the volume while the service is stopped or use SQLite's supported backup mechanism; do not copy an actively changing SQLite file alone. Never publish private launch env files or volume contents.

## Acceptance scope

Local target:20 concurrent metadata readers, bounded50-row lists, and one large upload. Record measured p95 separately; passing finite tests is not production capacity certification. The live browser acceptance creates an actual engine-backed run, verifies downloaded artifacts/export contents, creates/restores a real snapshot, closes/reopens its browser profile, restarts/recreates only that app, denies cross-owner access, and verifies account rotation and logout revocation. Full HTTP, session/security, migration, quota, schema and snapshot corruption tests are under runtime/tests.
