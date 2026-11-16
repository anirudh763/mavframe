-- Optional reference schema for the Mavframe local-first sync connector.
-- Run only in a Supabase project you own. Do not use a service-role key in the browser.
-- Apply as a trusted table/function owner with BYPASSRLS (or superuser), never a browser role.
-- FORCE RLS stays enabled; the definer RPCs scope every write to auth.uid().
-- Keep new definer functions and their grants atomic, including psql application.
begin;

do $$
begin
  if current_user in ('anon', 'authenticated') or not exists (
    select 1 from pg_catalog.pg_roles where rolname = current_user and (rolsuper or rolbypassrls)
  ) then
    raise exception 'apply_as_trusted_bypassrls_owner' using errcode = '42501';
  end if;
end;
$$;

create table if not exists public.mavframe_sync (
  owner_id uuid not null references auth.users(id) on delete cascade,
  collection text not null check (collection in ('saved_views', 'preferences')),
  revision bigint not null check (revision > 0),
  payload jsonb not null,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (owner_id, collection),
  check (pg_catalog.octet_length(payload::text) <= 49152)
);

-- Existing installations must not leave the table owned by a browser role.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_class c join pg_catalog.pg_roles r on r.oid = c.relowner
    where c.oid = 'public.mavframe_sync'::regclass and (r.rolsuper or r.rolbypassrls)
      and r.rolname not in ('anon', 'authenticated')
  ) then
    raise exception 'table_requires_trusted_bypassrls_owner' using errcode = '42501';
  end if;
end;
$$;

alter table public.mavframe_sync enable row level security;
alter table public.mavframe_sync force row level security;
revoke all on public.mavframe_sync from public, anon, authenticated;
grant select on public.mavframe_sync to authenticated;

drop policy if exists mavframe_sync_select_own on public.mavframe_sync;
create policy mavframe_sync_select_own on public.mavframe_sync for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists mavframe_sync_insert_own on public.mavframe_sync;
drop policy if exists mavframe_sync_update_own on public.mavframe_sync;
drop policy if exists mavframe_sync_delete_own on public.mavframe_sync;

create or replace function public.mavframe_sync_put(p_collection text, p_expected_revision bigint, p_payload jsonb)
returns public.mavframe_sync language plpgsql security definer set search_path = '' as $$
declare result public.mavframe_sync;
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  if p_collection is null or p_collection not in ('saved_views', 'preferences') or p_expected_revision is null or p_expected_revision < 0 or p_payload is null or pg_catalog.octet_length(p_payload::text) > 49152 then
    raise exception 'invalid_sync_payload' using errcode = '22023';
  end if;
  if p_expected_revision = 0 then
    insert into public.mavframe_sync(owner_id, collection, revision, payload, updated_at)
      values (auth.uid(), p_collection, 1, p_payload, pg_catalog.now()) on conflict (owner_id, collection) do nothing returning * into result;
  else
    update public.mavframe_sync set payload = p_payload, revision = revision + 1, updated_at = pg_catalog.now()
      where owner_id = auth.uid() and collection = p_collection and revision = p_expected_revision returning * into result;
  end if;
  if not found then raise exception 'revision_conflict' using errcode = '40001'; end if;
  return result;
end;
$$;

create or replace function public.mavframe_sync_delete(p_collection text, p_expected_revision bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  if p_collection is null or p_collection not in ('saved_views', 'preferences') or p_expected_revision is null or p_expected_revision < 1 then raise exception 'invalid_sync_delete' using errcode = '22023'; end if;
  delete from public.mavframe_sync where owner_id = auth.uid() and collection = p_collection and revision = p_expected_revision;
  get diagnostics removed = row_count;
  return removed = 1;
end;
$$;

-- CREATE OR REPLACE retains an old function owner; explicitly bind both to this trusted installer.
alter function public.mavframe_sync_put(text, bigint, jsonb) owner to current_user;
alter function public.mavframe_sync_delete(text, bigint) owner to current_user;

revoke all on function public.mavframe_sync_put(text, bigint, jsonb) from public, anon;
revoke all on function public.mavframe_sync_delete(text, bigint) from public, anon;
grant execute on function public.mavframe_sync_put(text, bigint, jsonb) to authenticated;
grant execute on function public.mavframe_sync_delete(text, bigint) to authenticated;

commit;
