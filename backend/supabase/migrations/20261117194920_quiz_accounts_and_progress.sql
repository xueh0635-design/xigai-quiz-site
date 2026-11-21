create table public.quiz_members (
  account_id uuid primary key references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now()
);

create table public.quiz_invites (
  invite_hash text primary key check (invite_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create table public.quiz_state (
  account_id uuid not null references public.quiz_members(account_id) on delete cascade,
  kind text not null check (kind in ('history', 'star', 'session')),
  record_key text not null check (char_length(record_key) between 1 and 160),
  revision bigint not null check (revision between 0 and 9999999999999),
  change_id uuid not null,
  payload jsonb not null check (
    octet_length(payload::text) <= 240000 and
    ((kind = 'star' and jsonb_typeof(payload) = 'boolean')
      or (kind in ('history', 'session') and jsonb_typeof(payload) = 'object'))
  ),
  primary key (account_id, kind, record_key)
);

alter table public.quiz_members enable row level security;
alter table public.quiz_invites enable row level security;
alter table public.quiz_state enable row level security;

revoke all on public.quiz_members, public.quiz_invites, public.quiz_state from anon, authenticated;
grant select on public.quiz_members to authenticated;
grant select, insert, update on public.quiz_state to authenticated;
grant select, insert on public.quiz_members to service_role;
grant select, insert, update on public.quiz_invites to service_role;

create policy "read own membership" on public.quiz_members for select to authenticated
using ((select auth.uid()) = account_id);

create policy "read own quiz state" on public.quiz_state for select to authenticated
using ((select auth.uid()) = account_id);

create policy "insert own quiz state" on public.quiz_state for insert to authenticated
with check ((select auth.uid()) = account_id);

create policy "update own quiz state" on public.quiz_state for update to authenticated
using ((select auth.uid()) = account_id)
with check ((select auth.uid()) = account_id);

create function public.claim_quiz_invite(invite_digest text)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with claimed as (
    update public.quiz_invites
      set consumed_at = now()
      where invite_hash = invite_digest and consumed_at is null and expires_at > now()
      returning 1
  )
  select exists (select 1 from claimed)
$$;

revoke all on function public.claim_quiz_invite(text) from public, anon, authenticated;
grant execute on function public.claim_quiz_invite(text) to service_role;

create function public.merge_quiz_state(changes jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
begin
  if actor is null or not exists (select 1 from public.quiz_members where account_id = actor) then
    raise exception 'account not enrolled' using errcode = '42501';
  end if;
  if jsonb_typeof(changes) is distinct from 'array'
    or jsonb_array_length(changes) > 100
    or octet_length(changes::text) > 350000 then
    raise exception 'invalid changes' using errcode = '22023';
  end if;

  insert into public.quiz_state as old (account_id, kind, record_key, revision, change_id, payload)
    select actor, entry.kind, entry.record_key, entry.revision, entry.change_id, entry.payload
    from jsonb_to_recordset(changes) as entry(
      kind text, record_key text, revision bigint, change_id uuid, payload jsonb
    )
    on conflict (account_id, kind, record_key) do update
    set revision = excluded.revision, change_id = excluded.change_id, payload = excluded.payload
    where (excluded.revision, excluded.change_id) > (old.revision, old.change_id);
end;
$$;

revoke all on function public.merge_quiz_state(jsonb) from public, anon;
grant execute on function public.merge_quiz_state(jsonb) to authenticated;
