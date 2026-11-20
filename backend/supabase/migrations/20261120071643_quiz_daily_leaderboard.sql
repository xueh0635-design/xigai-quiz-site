create table quiz_pk_private.leaderboard_profiles (
  account_id uuid primary key references public.quiz_members(account_id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 16 and nickname !~ '[[:cntrl:]]')
);

alter table quiz_pk_private.leaderboard_profiles enable row level security;
revoke all on quiz_pk_private.leaderboard_profiles from public, anon, authenticated;

create function quiz_pk_private.leaderboard_today()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
  study_day date := (statement_timestamp() at time zone 'Asia/Shanghai')::date;
  start_ms bigint := (extract(epoch from (study_day::timestamp at time zone 'Asia/Shanghai')) * 1000)::bigint;
  end_ms bigint := start_ms + 86400000;
begin
  return (
    with eligible as (
      select account_id, nickname from quiz_pk_private.leaderboard_profiles
      union all
      select actor, null::text where not exists (
        select 1 from quiz_pk_private.leaderboard_profiles where account_id = actor
      )
    ), activity as (
      -- quiz_state stores a single latest marked attempt per account and original question.
      select history.account_id, count(*) as answered
      from eligible
      join public.quiz_state history using (account_id)
      join quiz_pk_private.questions question on question.question_id = history.record_key
      where history.kind = 'history' and jsonb_typeof(history.payload->'wrong') = 'boolean'
        and case when history.payload->>'last' ~ '^[0-9]{1,13}$'
          then (history.payload->>'last')::bigint >= start_ms and (history.payload->>'last')::bigint < end_ms
          else false end
      group by history.account_id
    ), ranking as (
      select eligible.account_id, nickname, answered, rank() over (order by answered desc) as position
      from eligible join activity using (account_id)
      where nickname is not null
    )
    select jsonb_build_object(
      'day', to_char(study_day, 'YYYY-MM-DD'),
      'entries', coalesce((
        select jsonb_agg(jsonb_build_object(
          'nickname', nickname, 'rank', position, 'answered', answered, 'isMe', account_id = actor
        ) order by position, nickname, account_id) from ranking
      ), '[]'::jsonb),
      'me', (
        select jsonb_build_object('joined', eligible.nickname is not null, 'nickname', eligible.nickname,
          'answered', coalesce(activity.answered, 0), 'rank', ranking.position)
        from eligible left join activity using (account_id)
        left join ranking using (account_id) where eligible.account_id = actor
      )
    )
  );
end;
$$;

create function quiz_pk_private.leaderboard_set_nickname(requested_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
  label text := nullif(btrim(requested_nickname), '');
begin
  if requested_nickname is null then
    delete from quiz_pk_private.leaderboard_profiles where account_id = actor;
  else
    if char_length(label) > 16 or label ~ '[[:cntrl:]]' then
      raise exception 'leaderboard_invalid_nickname' using errcode = '22023';
    end if;
    insert into quiz_pk_private.leaderboard_profiles as previous (account_id, nickname)
      values (actor, coalesce(label, '学友' || upper(left(gen_random_uuid()::text, 4))))
      on conflict (account_id) do update set nickname = coalesce(label, previous.nickname);
  end if;
  return quiz_pk_private.leaderboard_today();
end;
$$;

create function public.quiz_leaderboard_today()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select quiz_pk_private.leaderboard_today() $$;

create function public.quiz_leaderboard_set_nickname(nickname text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select quiz_pk_private.leaderboard_set_nickname(nickname) $$;

revoke execute on function quiz_pk_private.leaderboard_today(), quiz_pk_private.leaderboard_set_nickname(text),
  public.quiz_leaderboard_today(), public.quiz_leaderboard_set_nickname(text) from public, anon, authenticated;
grant execute on function quiz_pk_private.leaderboard_today(), quiz_pk_private.leaderboard_set_nickname(text),
  public.quiz_leaderboard_today(), public.quiz_leaderboard_set_nickname(text) to authenticated;
