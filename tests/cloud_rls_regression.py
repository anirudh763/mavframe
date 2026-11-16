"""Real PostgreSQL policy gate; run explicitly with LEASEQ_TEST_ENV_FILE set.

The private JSON fixture must point at the disposable localhost:55444/leaseq
instance. auth.uid uses a transaction-local identity fixture, not hosted JWT auth.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import uuid

import pytest

SCHEMA = Path(__file__).parents[1] / "docs" / "SUPABASE_SYNC_SETUP.sql"
A = "00000000-0000-0000-0000-00000000000a"
B = "00000000-0000-0000-0000-00000000000b"


@pytest.fixture(scope="module", params=[1, 2], ids=["fresh", "reapplied"])
def store(request):
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    env_file = os.environ.get("LEASEQ_TEST_ENV_FILE")
    assert env_file, "set LEASEQ_TEST_ENV_FILE to the disposable policy fixture"
    params = conninfo_to_dict(json.loads(Path(env_file).read_text())["LEASEQ_DATABASE_URL"])
    assert (params.get("host"), params.get("port"), params.get("dbname")) == (
        "127.0.0.1", "55444", "leaseq"
    ), "refusing policy checks outside the designated disposable instance"
    admin_url = make_conninfo(**dict(params, dbname="postgres"))
    suffix = uuid.uuid4().hex[:12]
    database = f"mavframe_cas_{suffix}"
    owner, auth, anon = (f"mavframe_{role}_{suffix}" for role in ("owner", "auth", "anon"))
    created_roles = []
    published = SCHEMA.read_text()
    schema = re.sub(r"\bauthenticated\b", auth, published)
    schema = re.sub(r"\banon\b", anon, schema)
    try:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            for role in (owner, auth, anon):
                bypass = sql.SQL("BYPASSRLS") if role == owner else sql.SQL("NOBYPASSRLS")
                admin.execute(sql.SQL("CREATE ROLE {} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT {}").format(sql.Identifier(role), bypass))
                created_roles.append(role)
            admin.execute(sql.SQL("CREATE DATABASE {} OWNER {}").format(sql.Identifier(database), sql.Identifier(owner)))
        scratch_url = make_conninfo(**dict(params, dbname=database))
        with psycopg.connect(scratch_url, autocommit=True) as admin:
            admin.execute("CREATE SCHEMA auth")
            admin.execute("CREATE TABLE auth.users (id uuid PRIMARY KEY)")
            admin.execute("CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$")
            admin.execute("GRANT USAGE ON SCHEMA auth TO PUBLIC")
            admin.execute("GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC")
            admin.execute(sql.SQL("GRANT REFERENCES ON auth.users TO {}").format(sql.Identifier(owner)))
            admin.execute("INSERT INTO auth.users VALUES (%s), (%s)", (A, B))
            admin.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(owner)))
            for _ in range(request.param):
                admin.execute(schema)

        def run(role, identity, query, args=()):
            with psycopg.connect(scratch_url) as conn:
                conn.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(role)))
                conn.execute("SELECT set_config('request.jwt.claim.sub', %s, true)", (identity or "",))
                result = conn.execute(query, args)
                return result.fetchall() if result.description else result.rowcount

        yield {"run": run, "owner": owner, "auth": auth, "anon": anon,
               "schema": schema, "error": psycopg.Error}
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=%s AND pid<>pg_backend_pid()", (database,))
            admin.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(database)))
            for role in created_roles:
                admin.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(role)))
            assert admin.execute("SELECT count(*) FROM pg_database WHERE datname=%s", (database,)).fetchone()[0] == 0
            assert admin.execute("SELECT count(*) FROM pg_roles WHERE rolname=ANY(%s)", (created_roles,)).fetchone()[0] == 0


@pytest.fixture(autouse=True)
def clear_rows(store):
    store["run"](store["owner"], None, "DELETE FROM public.mavframe_sync")


def put(store, identity=A, revision=0, payload=None):
    from psycopg.types.json import Jsonb
    return store["run"](store["auth"], identity,
        "SELECT revision FROM public.mavframe_sync_put(%s,%s,%s)",
        ("preferences", revision, Jsonb({"theme": "light"} if payload is None else payload)))[0][0]


def delete(store, identity=A, revision=1):
    return store["run"](store["auth"], identity,
        "SELECT public.mavframe_sync_delete(%s,%s)", ("preferences", revision))[0][0]


def denied(store, role, identity, query, args=(), state="42501"):
    with pytest.raises(store["error"]) as failure:
        store["run"](role, identity, query, args)
    assert failure.value.sqlstate == state


def test_direct_owner_update_cannot_bypass_revision(store):
    assert put(store) == 1
    denied(store, store["auth"], A,
           "UPDATE public.mavframe_sync SET payload='{}' WHERE owner_id=%s", (A,))
    assert store["run"](store["auth"], A,
        "SELECT revision,payload FROM public.mavframe_sync")[0] == (1, {"theme": "light"})


@pytest.mark.parametrize("operation", ["insert", "delete"])
def test_other_direct_owner_writes_are_denied(store, operation):
    assert put(store) == 1
    query = ("INSERT INTO public.mavframe_sync(owner_id,collection,revision,payload) VALUES (%s,'saved_views',1,'{}')"
             if operation == "insert" else "DELETE FROM public.mavframe_sync WHERE owner_id=%s")
    denied(store, store["auth"], A, query, (A,))


def test_owner_rpc_revision_conflicts_and_hard_delete(store):
    assert put(store) == 1
    assert put(store, revision=1, payload={"theme": "dark"}) == 2
    denied(store, store["auth"], A,
           "SELECT public.mavframe_sync_put('preferences',1,'{}')", state="40001")
    assert delete(store, revision=1) is False
    assert delete(store, revision=2) is True
    assert store["run"](store["auth"], A, "SELECT count(*) FROM public.mavframe_sync")[0][0] == 0
    assert delete(store, revision=2) is False
    # The existing protocol hard-deletes; recreating the collection starts at 1.
    assert put(store) == 1


def test_cross_user_reads_and_rpc_writes_are_isolated(store):
    assert put(store) == 1
    assert store["run"](store["auth"], B, "SELECT * FROM public.mavframe_sync") == []
    denied(store, store["auth"], B,
           "SELECT public.mavframe_sync_put('preferences',1,'{}')", state="40001")
    assert delete(store, identity=B) is False
    assert put(store, identity=B) == 1
    assert store["run"](store["auth"], B, "SELECT owner_id::text FROM public.mavframe_sync") == [(B,)]
    assert store["run"](store["auth"], A, "SELECT revision FROM public.mavframe_sync") == [(1,)]


@pytest.mark.parametrize("query", [
    "INSERT INTO public.mavframe_sync(owner_id,collection,revision,payload) VALUES (%s,'saved_views',1,'{}')",
    "UPDATE public.mavframe_sync SET revision=2 WHERE owner_id=%s",
    "DELETE FROM public.mavframe_sync WHERE owner_id=%s",
])
def test_cross_user_direct_writes_are_denied(store, query):
    assert put(store) == 1
    denied(store, store["auth"], B, query, (A,))


@pytest.mark.parametrize("query", [
    "SELECT * FROM public.mavframe_sync",
    "INSERT INTO public.mavframe_sync(owner_id,collection,revision,payload) VALUES (auth.uid(),'saved_views',1,'{}')",
    "SELECT public.mavframe_sync_put('preferences',0,'{}')",
    "SELECT public.mavframe_sync_delete('preferences',1)",
])
def test_anonymous_role_is_denied_even_with_a_claim(store, query):
    denied(store, store["anon"], A, query)


@pytest.mark.parametrize("query", [
    "SELECT public.mavframe_sync_put('preferences',0,'{}')",
    "SELECT public.mavframe_sync_delete('preferences',1)",
])
def test_rpc_requires_identity(store, query):
    denied(store, store["auth"], None, query, state="28000")


@pytest.mark.parametrize("query", [
    "SELECT public.mavframe_sync_put(NULL,0,'{}')",
    "SELECT public.mavframe_sync_put('invalid',0,'{}')",
    "SELECT public.mavframe_sync_put('preferences',NULL,'{}')",
    "SELECT public.mavframe_sync_put('preferences',-1,'{}')",
    "SELECT public.mavframe_sync_put('preferences',0,NULL)",
    "SELECT public.mavframe_sync_put('preferences',0,jsonb_build_object('text',repeat('x',49153)))",
    "SELECT public.mavframe_sync_delete(NULL,1)",
    "SELECT public.mavframe_sync_delete('invalid',1)",
    "SELECT public.mavframe_sync_delete('preferences',NULL)",
    "SELECT public.mavframe_sync_delete('preferences',0)",
    "SELECT public.mavframe_sync_delete('preferences',-1)",
])
def test_rpc_rejects_invalid_parameters(store, query):
    denied(store, store["auth"], A, query, state="22023")


def test_definers_have_trusted_owner_and_empty_search_path(store):
    functions = store["run"](store["owner"], None, """
        SELECT p.proname,p.prosecdef,p.proconfig,r.rolname,r.rolsuper,r.rolbypassrls,r.rolcanlogin,p.prosrc
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
        WHERE n.nspname='public' AND p.proname IN ('mavframe_sync_put','mavframe_sync_delete')
        ORDER BY p.proname
    """)
    assert len(functions) == 2
    for name, definer, config, owner, superuser, bypass, login, body in functions:
        assert definer and config == ['search_path=""'], name
        assert owner == store["owner"] and bypass and not superuser and not login
        assert "auth.uid()" in body and "public.mavframe_sync" in body
        assert not re.search(r"\bEXECUTE\b", body, re.I), "no elevated dynamic SQL"
        assert not re.search(r"\b(?:FROM|INTO|UPDATE)\s+mavframe_sync\b", body, re.I)
    assert store["run"](store["owner"], None, "SELECT relrowsecurity,relforcerowsecurity FROM pg_catalog.pg_class WHERE oid='public.mavframe_sync'::regclass") == [(True, True)]


def test_browser_role_cannot_install_definer_schema(store):
    assert put(store) == 1
    denied(store, store["auth"], A, store["schema"])
    assert store["run"](store["auth"], A, "SELECT revision FROM public.mavframe_sync") == [(1,)]


def test_reapplication_removes_legacy_public_writes_and_dml_policies(store):
    from psycopg import sql

    assert put(store) == 1
    # Reproduce an older/custom installation, including inherited PUBLIC grants.
    for operation, clause in [
        ("insert", "WITH CHECK (owner_id = auth.uid())"),
        ("update", "USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())"),
        ("delete", "USING (owner_id = auth.uid())"),
    ]:
        statement = sql.SQL("CREATE POLICY {} ON public.mavframe_sync FOR {} TO {} " + clause).format(
            sql.Identifier(f"mavframe_sync_{operation}_own"), sql.SQL(operation), sql.Identifier(store["auth"]))
        store["run"](store["owner"], None, statement)
    store["run"](store["owner"], None,
                 "GRANT INSERT,UPDATE,DELETE ON public.mavframe_sync TO PUBLIC")
    assert store["run"](store["auth"], A,
        "UPDATE public.mavframe_sync SET payload='{}' WHERE owner_id=%s RETURNING revision", (A,)) == [(1,)]

    store["run"](store["owner"], None, store["schema"])
    for role in (store["auth"], store["anon"]):
        for privilege in ("INSERT", "UPDATE", "DELETE"):
            assert store["run"](role, A,
                "SELECT pg_catalog.has_table_privilege(current_user,'public.mavframe_sync',%s)", (privilege,)) == [(False,)]
    assert store["run"](store["owner"], None,
        "SELECT cmd FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='mavframe_sync'") == [("SELECT",)]
    denied(store, store["auth"], A, "UPDATE public.mavframe_sync SET payload='{}'")
    assert put(store, revision=1) == 2
    assert store["run"](store["auth"], B, "SELECT * FROM public.mavframe_sync") == []
    denied(store, store["auth"], B,
           "SELECT public.mavframe_sync_put('preferences',2,'{}')", state="40001")
    assert delete(store, identity=B, revision=2) is False
    denied(store, store["anon"], A, "SELECT public.mavframe_sync_put('preferences',2,'{}')")


def test_schema_reapplication_preserves_data_and_permissions(store):
    assert put(store) == 1
    store["run"](store["owner"], None, store["schema"])
    assert store["run"](store["auth"], A, "SELECT revision,payload FROM public.mavframe_sync") == [(1, {"theme": "light"})]
    assert put(store, revision=1) == 2
    denied(store, store["auth"], A, "UPDATE public.mavframe_sync SET payload='{}'")


def test_only_one_concurrent_expected_revision_write_succeeds(store):
    assert put(store) == 1
    def update(_):
        try:
            return put(store, revision=1)
        except store["error"] as failure:
            return failure.sqlstate
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        answers = list(pool.map(update, range(2)))
    assert sorted(map(str, answers)) == ["2", "40001"]
    assert store["run"](store["auth"], A, "SELECT revision FROM public.mavframe_sync") == [(2,)]
