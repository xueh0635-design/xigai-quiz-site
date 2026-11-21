alter table quiz_pk_private.live_rooms add column completed_at timestamptz;

create function quiz_pk_private.social_stamp_room_completion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.completed_at := clock_timestamp();
  return new;
end;
$$;

create trigger quiz_social_stamp_room_completion
before update of status on quiz_pk_private.live_rooms
for each row when (old.status is distinct from new.status and new.status = 'complete')
execute function quiz_pk_private.social_stamp_room_completion();

revoke execute on function quiz_pk_private.social_stamp_room_completion()
  from public, anon, authenticated;

create table quiz_pk_private.social_reactions (
  pair_id uuid not null references quiz_pk_private.pairs(id) on delete cascade,
  study_day date not null,
  sender uuid not null references public.quiz_members(account_id) on delete cascade,
  kind text not null check (kind in ('cheer', 'high_five')),
  primary key (pair_id, study_day, sender, kind)
);

alter table quiz_pk_private.social_reactions enable row level security;
revoke all on quiz_pk_private.social_reactions from public, anon, authenticated;

create function quiz_pk_private.social_daily(
  operation text, requested_reaction text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
  active_pair uuid;
  partner uuid;
  today date := (statement_timestamp() at time zone 'Asia/Shanghai')::date;
  day_start timestamptz := today::timestamp at time zone 'Asia/Shanghai';
  day_end timestamptz := (today + 1)::timestamp at time zone 'Asia/Shanghai';
  start_ms bigint := (extract(epoch from day_start) * 1000)::bigint;
  end_ms bigint := (extract(epoch from day_end) * 1000)::bigint;
  practice_target constant integer := 5;
  shared_target constant integer := 1;
  my_practiced integer;
  partner_practiced integer;
  shared_rounds integer;
  sent jsonb := '[]'::jsonb;
  received jsonb := '[]'::jsonb;
  practice_complete boolean;
  shared_complete boolean;
  mission jsonb;
begin
  if operation is null or operation not in ('state', 'react') then
    raise exception 'social_invalid_operation' using errcode = '22023';
  end if;
  if operation = 'react' and (
    requested_reaction is null or requested_reaction not in ('cheer', 'high_five')
  ) then
    raise exception 'social_invalid_reaction' using errcode = '22023';
  end if;

  select p.id, case when p.first_account = actor then p.second_account else p.first_account end
    into active_pair, partner
    from quiz_pk_private.pairs p
    join quiz_pk_private.active_pair_members m on m.pair_id = p.id
    where m.account_id = actor and actor in (p.first_account, p.second_account) and p.closed_at is null
    for share of p;

  if active_pair is null then
    if operation = 'react' then
      raise exception 'social_pair_required' using errcode = '42501';
    end if;
  else
    if operation = 'react' then
      insert into quiz_pk_private.social_reactions (pair_id, study_day, sender, kind)
      values (active_pair, today, actor, requested_reaction)
      on conflict (pair_id, study_day, sender, kind) do nothing;
    end if;

    select count(*) filter (where progress.account_id = actor),
      count(*) filter (where progress.account_id = partner)
      into my_practiced, partner_practiced
      from public.quiz_state progress
      join quiz_pk_private.questions question on question.question_id = progress.record_key
      where progress.account_id in (actor, partner) and progress.kind = 'history'
        and jsonb_typeof(progress.payload->'wrong') = 'boolean'
        and case when (progress.payload->>'last') ~ '^[0-9]{1,13}$' then
          (progress.payload->>'last')::bigint >= start_ms
          and (progress.payload->>'last')::bigint < end_ms
        else false end;

    -- Earlier completed rooms used a deadline exactly two hours after completion.
    select count(*) into shared_rounds from quiz_pk_private.live_rooms room
      where room.pair_id = active_pair and room.status = 'complete'
        and coalesce(room.completed_at, room.expires_at - interval '2 hours') >= day_start
        and coalesce(room.completed_at, room.expires_at - interval '2 hours') < day_end;

    select coalesce(jsonb_agg(item.kind order by item.kind) filter (where item.sender = actor), '[]'::jsonb),
      coalesce(jsonb_agg(item.kind order by item.kind) filter (where item.sender = partner), '[]'::jsonb)
      into sent, received
      from quiz_pk_private.social_reactions item
      where item.pair_id = active_pair and item.study_day = today and item.sender in (actor, partner);

    practice_complete := my_practiced >= practice_target and partner_practiced >= practice_target;
    shared_complete := shared_rounds >= shared_target;
    mission := jsonb_build_object(
      'target',practice_target,'myPracticed',my_practiced,'partnerPracticed',partner_practiced,
      'sharedRounds',shared_rounds,'sharedTarget',shared_target,'practiceComplete',practice_complete,
      'sharedComplete',shared_complete,'complete',practice_complete and shared_complete
    );
  end if;

  return jsonb_build_object(
    'paired',active_pair is not null,'day',to_char(today,'YYYY-MM-DD'),'mission',mission,
    'reactions',jsonb_build_object('sent',sent,'received',received)
  );
end;
$$;

create function public.quiz_social_state()
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.social_daily('state') $$;

create function public.quiz_social_react(reaction text)
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.social_daily('react', reaction) $$;

revoke execute on function quiz_pk_private.social_daily(text,text),
  public.quiz_social_state(), public.quiz_social_react(text) from public, anon, authenticated;
grant execute on function quiz_pk_private.social_daily(text,text),
  public.quiz_social_state(), public.quiz_social_react(text) to authenticated;
