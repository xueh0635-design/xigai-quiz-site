create table quiz_internal.development_worker (
  singleton boolean primary key default true check (singleton),
  owner_id uuid references auth.users(id) on delete set null,
  worker_hash bytea not null,
  pairing_hash bytea,
  pairing_expires_at timestamptz,
  last_seen_at timestamptz
);

create table quiz_internal.development_requests (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  brief text not null check (char_length(brief) between 1 and 2000),
  status text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed')),
  submitted_at timestamptz not null default statement_timestamp(),
  lease uuid,
  lease_until timestamptz,
  attempts smallint not null default 0,
  result text,
  pr_url text
);

alter table quiz_internal.development_worker enable row level security;
alter table quiz_internal.development_requests enable row level security;
revoke all on quiz_internal.development_worker, quiz_internal.development_requests from public, anon, authenticated;

create function public.quiz_development_client(action text, payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  worker quiz_internal.development_worker%rowtype;
  pairing_open boolean;
  request_id uuid;
  brief_text text;
begin
  if caller is null then return '{"available":false}'::jsonb; end if;
  select * into worker from quiz_internal.development_worker where singleton for update;
  if not found then return '{"available":false}'::jsonb; end if;

  pairing_open := worker.owner_id is null
    and worker.pairing_hash is not null and coalesce(worker.pairing_expires_at > statement_timestamp(), false);
  if action = 'pair' then
    if not pairing_open or length(coalesce(payload->>'code', '')) <> 32
       or sha256(convert_to(payload->>'code', 'UTF8')) is distinct from worker.pairing_hash then
      return jsonb_build_object('available', false, 'pairing', coalesce(pairing_open, false), 'error', 'pairing');
    end if;
    update quiz_internal.development_worker
       set owner_id = caller, pairing_hash = null, pairing_expires_at = null where singleton;
    worker.owner_id := caller;
  end if;
  if worker.owner_id is distinct from caller then
    return jsonb_build_object('available', false, 'pairing', coalesce(pairing_open, false));
  end if;

  if action = 'submit' then
    request_id := (payload->>'id')::uuid;
    brief_text := btrim(payload->>'brief');
    if request_id is null or brief_text is null or length(brief_text) not between 1 and 2000 then
      return '{"available":true,"error":"brief"}'::jsonb;
    end if;
    insert into quiz_internal.development_requests (id, owner_id, brief)
      values (request_id, caller, brief_text)
      on conflict (id) do nothing;
  end if;

  return jsonb_build_object(
    'available', true,
    'macOnline', coalesce(worker.last_seen_at > statement_timestamp() - interval '2 minutes', false),
    'requests', coalesce((
      select jsonb_agg(to_jsonb(request) order by request.submitted_at desc)
      from (
        select id, brief, status, submitted_at, result, pr_url
        from quiz_internal.development_requests where owner_id = caller
        order by submitted_at desc limit 15
      ) request
    ), '[]'::jsonb)
  );
end;
$$;

create function public.quiz_development_worker(token text, action text, payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  worker quiz_internal.development_worker%rowtype;
  job quiz_internal.development_requests%rowtype;
  receipt_url text := payload->>'pr_url';
begin
  if length(coalesce(token, '')) <> 64 then return '{"accepted":false}'::jsonb; end if;
  select * into worker from quiz_internal.development_worker
    where singleton and worker_hash = sha256(convert_to(token, 'UTF8')) for update;
  if not found then return '{"accepted":false}'::jsonb; end if;
  update quiz_internal.development_worker set last_seen_at = statement_timestamp() where singleton;
  if worker.owner_id is null then return '{"accepted":true,"job":null}'::jsonb; end if;

  if action = 'claim' then
    update quiz_internal.development_requests
      set status = 'failed', result = 'Mac 多次中断。请重新发送需求。', lease = null, lease_until = null
      where owner_id = worker.owner_id and status = 'running'
        and lease_until <= statement_timestamp() and attempts >= 3;
    if exists (
      select 1 from quiz_internal.development_requests
       where owner_id = worker.owner_id and status = 'running' and lease_until > statement_timestamp()
    ) then return '{"accepted":true,"job":null}'::jsonb; end if;
    select * into job from quiz_internal.development_requests
      where owner_id = worker.owner_id and (status = 'queued' or
        (status = 'running' and lease_until <= statement_timestamp()))
      order by submitted_at limit 1;
    if not found then return '{"accepted":true,"job":null}'::jsonb; end if;
    update quiz_internal.development_requests
      set status = 'running', lease = gen_random_uuid(),
          lease_until = statement_timestamp() + interval '20 minutes', attempts = attempts + 1
      where id = job.id returning * into job;
    return jsonb_build_object('accepted', true, 'job',
      jsonb_build_object('id', job.id, 'brief', job.brief, 'lease', job.lease));
  end if;

  if action = 'finish' and payload->>'status' in ('ready', 'failed') then
    if receipt_url is not null and receipt_url !~ '^https://github\.com/xueh0635-design/xigai-quiz-development/pull/[0-9]+$' then
      return '{"accepted":false}'::jsonb;
    end if;
    update quiz_internal.development_requests
       set status = payload->>'status', result = left(payload->>'result', 1400),
           pr_url = receipt_url, lease = null, lease_until = null
     where id = (payload->>'id')::uuid and owner_id = worker.owner_id
       and status = 'running' and lease = (payload->>'lease')::uuid;
    return jsonb_build_object('accepted', found);
  end if;
  return '{"accepted":false}'::jsonb;
end;
$$;

revoke all on function public.quiz_development_client(text, jsonb) from public, anon, authenticated;
grant execute on function public.quiz_development_client(text, jsonb) to authenticated;
revoke all on function public.quiz_development_worker(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.quiz_development_worker(text, text, jsonb) to anon;
