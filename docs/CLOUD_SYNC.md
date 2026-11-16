# Optional local-first sync reference

Mavframe's browser-local profile is not a cloud identity. The optional connector signs in separately with Supabase Auth using the project's public anon key; it never accepts a service-role key. Access tokens stay in memory and are cleared on logout or page close. Local edits remain on this device until a user explicitly connects and presses Sync. No hosted provider is configured by default.

Only two collections are allowlisted: saved view settings and theme preferences. Capture bytes, decoded payloads, signed material, browser profile password verifiers and sessions are excluded. Requests omit credentials and referrers, have a 10 second deadline, and cap request payloads at 48 KiB and response bodies at 64 KiB. Sync compares revisions and returns a pending/conflict state; differing data is never overwritten without an explicit keep-local/upload or use-remote choice. Use-remote is staged for explicit local application. Authenticated browser roles can SELECT their own rows; only the revision-checked RPCs can write or delete. RPCs reject stale revisions for the current row. Deletion physically removes the row; recreation starts at revision 1, so a revision is not a generation token across delete/recreate cycles. Network or acknowledgement failures remain unsynced.

To configure a project you own, apply or reapply `SUPABASE_SYNC_SETUP.sql` as the existing trusted table/function owner with BYPASSRLS (or a superuser), never as `anon`/`authenticated`. That owner must remain unavailable to browser users. The script rejects an untrusted installer/table owner, retains forced RLS for reads, uses an empty definer search path and binds both functions to the trusted installer. It revokes direct browser INSERT/UPDATE/DELETE even on an existing installation. Then enable Supabase Auth, and provide the project URL and public anon key in the Account Settings sync form. Before publishing that configuration, add only its exact origin to the `connect-src` directive in `index.html` (for example `connect-src 'self' https://PROJECT-REF.supabase.co;`). The shipped policy allows same-origin requests only; it does not open arbitrary HTTPS destinations. Review the SQL, RLS policies and provider's retention settings yourself. Reads use forced RLS; trusted SECURITY DEFINER RPCs check `auth.uid()` and include explicit owner predicates for every write. Client-side owner filters are not authorization. This repository has no configured project, does not create cloud resources, and has not been verified against a real Supabase project. Local fake-service tests exercise the HTTP contract only; they do not prove deployed RLS or provider security. Sync is not end-to-end encrypted.


## Local reference-policy gate

The `reference-sync-policy` CI job runs the published SQL against a disposable PostgreSQL 16 service. It tests fresh and repeated application, direct-write denial, owner RPC writes and revision increments, stale/concurrent updates and stale deletes, cross-user/anonymous denial, parameter bounds, trusted definer ownership and cleanup. Ordinary test roles cannot bypass RLS. No hosted provider or credentials are required.

To run locally, provide a private JSON file whose `LEASEQ_DATABASE_URL` points only to a disposable `127.0.0.1:55444/leaseq` administrator connection. Set its permissions to 0600 and export its path as `LEASEQ_TEST_ENV_FILE`. The test refuses other host/port/database combinations and creates/removes UUID-scoped databases and roles. In a task virtualenv:

```sh
python -m pip install -r requirements-policy.txt
python -m pytest -q tests/cloud_rls_regression.py
```

The explicit test filename keeps these PostgreSQL dependencies out of native-parser test discovery. The gate fails if its fixture is missing; CI cannot silently skip it. Its `auth.uid()` fixture uses a transaction-local claim, so passing this gate proves reference PostgreSQL semantics, not Supabase JWT validation, hosted authentication/session security or a deployed policy. Reapply the reviewed SQL to an owned existing project before expecting the tightened grants there; repository changes do not update a hosted database.
