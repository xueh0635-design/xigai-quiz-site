-- Current mastery uses one canonical answerable question; historical practice
-- uses append-only events. Legacy snapshots are explicitly labelled, not an
-- invented reconstruction of all attempts before this migration.
-- A client may first sync its snapshot to the old RPC and later upload the
-- original v2 event. Keep both immutable records, but count the answer once.
-- Multiple genuine v2 event IDs at the same millisecond remain distinct.
create function quiz_sync_private.effective_attempts(account uuid)
returns setof quiz_sync_private.attempts
language sql stable security invoker set search_path='' as $$
  select a.* from quiz_sync_private.attempts a
  where a.account_id=account and (a.source='v2' or (
    not exists(select 1 from quiz_sync_private.attempts verified
      where verified.account_id=a.account_id and verified.canonical_question_id=a.canonical_question_id
        and verified.occurred_at=a.occurred_at and verified.source='v2')
    and not exists(select 1 from quiz_sync_private.attempts later
      where later.account_id=a.account_id and later.canonical_question_id=a.canonical_question_id
        and later.occurred_at=a.occurred_at and later.source<>'v2' and later.sync_cursor>a.sync_cursor)
  ))
$$;
revoke all on function quiz_sync_private.effective_attempts(uuid) from public,anon,authenticated;
create index quiz_attempts_evidence on quiz_sync_private.attempts(account_id,canonical_question_id,occurred_at,source);

create function quiz_pk_private.progress_history(account uuid)
returns table(question_id text,chapter text,question_type text,answered boolean,correct boolean,review boolean)
language sql stable security invoker set search_path='' as $$
  select canonical_question_id,chapter,question_type,answered,correct,review from (
    select distinct on(q.canonical_question_id) q.canonical_question_id,q.chapter,q.question_type,
      verified.correct is not null or coalesce(jsonb_typeof(s.payload->'wrong')='boolean',false) as answered,
      coalesce(verified.correct,s.payload->'wrong'='false'::jsonb,false) as correct,
      coalesce(case when jsonb_typeof(s.payload->'review')='boolean' then s.payload->'review'='true'::jsonb
        else s.payload->'wrong'='true'::jsonb end,false) as review
    from public.quiz_state s join quiz_pk_private.questions q on q.question_id=s.record_key and q.answerable
    left join lateral (
      select a.correct from quiz_sync_private.attempts a
      where a.account_id=account and a.canonical_question_id=q.canonical_question_id and a.source='v2'
        and a.occurred_at=case when s.payload->>'last' ~ '^[0-9]{1,13}$' then (s.payload->>'last')::bigint end
      order by a.sync_cursor desc limit 1
    ) verified on true
    where s.account_id=account and s.kind='history'
    order by q.canonical_question_id,coalesce(jsonb_typeof(s.payload->'wrong')='boolean',false) desc,
      case when s.payload->>'last' ~ '^[0-9]{1,13}$' then (s.payload->>'last')::bigint else 0 end desc,
      s.revision desc,s.change_id desc
  ) latest
$$;
revoke all on function quiz_pk_private.progress_history(uuid) from public,anon,authenticated;

create or replace function quiz_pk_private.study_stats(account uuid,total_questions bigint)
returns jsonb language sql stable security invoker set search_path='' as $$
  with stats as (
    select count(*) filter(where answered) as answered,count(*) filter(where answered and correct) as correct
    from quiz_pk_private.progress_history(account)
  ), catalog as (
    select count(*) as total from quiz_pk_private.questions where answerable and question_id=canonical_question_id
  ), today as (
    select count(distinct canonical_question_id) as practiced from quiz_sync_private.attempts
    where account_id=account and (to_timestamp(occurred_at/1000.0) at time zone 'Asia/Shanghai')::date
      = (statement_timestamp() at time zone 'Asia/Shanghai')::date
  ) select jsonb_build_object(
    'answered',answered,'correct',correct,'today',practiced,
    'accuracy',coalesce(round(100.0*correct/nullif(answered,0)),0),
    'completion',coalesce(round(100.0*answered/nullif(total,0)),0),
    'avatar',(select jsonb_build_object('path',image.name,'revision',image.updated_at) from storage.objects image
      where image.bucket_id='quiz-pk-avatars' and image.name=account::text||'.jpg')
  ) from stats cross join catalog cross join today
$$;

create or replace function quiz_pk_private.progress_rollups(actor uuid,peer uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
  today date := (statement_timestamp() at time zone 'Asia/Shanghai')::date;
  first_ms bigint := (extract(epoch from ((today-6)::timestamp at time zone 'Asia/Shanghai'))*1000)::bigint;
  end_ms bigint := (extract(epoch from ((today+1)::timestamp at time zone 'Asia/Shanghai'))*1000)::bigint;
begin
  return (
    with catalog as (
      select question_id,chapter,coalesce(question_type,'未分类') as question_type
      from quiz_pk_private.questions where answerable and question_id=canonical_question_id
    ), dimensions as (
      select question_id,'chapter' as dimension,chapter as label from catalog
      union all select question_id,'type',question_type from catalog
    ), totals as (
      select dimension,label,count(*) as total from dimensions group by dimension,label
    ), snapshots as (
      select actor as account_id,* from quiz_pk_private.progress_history(actor)
      union all select peer,* from quiz_pk_private.progress_history(peer)
    ), daily as (
      select (to_timestamp(occurred_at/1000.0) at time zone 'Asia/Shanghai')::date as day,
        count(*) filter(where account_id=actor) as mine,
        count(*) filter(where account_id=actor and correct) as mine_correct,
        count(*) filter(where account_id=peer) as theirs,
        count(*) filter(where account_id=peer and correct) as theirs_correct
      from (select * from quiz_sync_private.effective_attempts(actor)
        union all select * from quiz_sync_private.effective_attempts(peer)) recorded
      where account_id in(actor,peer) and occurred_at>=first_ms and occurred_at<end_ms
      group by 1
    ), activity as (
      select dimension,label,
        count(*) filter(where account_id=actor and answered) as mine,
        count(*) filter(where account_id=actor and answered and correct) as mine_correct,
        count(*) filter(where account_id=actor and review) as mine_review,
        count(*) filter(where account_id=peer and answered) as theirs,
        count(*) filter(where account_id=peer and answered and correct) as theirs_correct,
        count(*) filter(where account_id=peer and review) as theirs_review
      from snapshots join dimensions using(question_id) group by dimension,label
    ), rollups as (
      select totals.dimension,totals.label,jsonb_build_object(totals.dimension,totals.label,'total',totals.total,
        'mine',coalesce(activity.mine,0),'mineCorrect',coalesce(activity.mine_correct,0),'mineReview',coalesce(activity.mine_review,0),
        'peer',coalesce(activity.theirs,0),'peerCorrect',coalesce(activity.theirs_correct,0),'peerReview',coalesce(activity.theirs_review,0)
      ) as row from totals left join activity using(dimension,label)
    ), test_candidates as (
      select s.account_id,bank.name as bank,totals.label as chapter,test.value,
        case when test.value->>'completedAt' ~ '^[0-9]{1,13}$' then (test.value->>'completedAt')::bigint else s.revision end as observed_at,s.revision
      from public.quiz_state s
      cross join lateral jsonb_each(case when jsonb_typeof(s.payload#>'{chapterStudy,tests}')='object'
        then s.payload#>'{chapterStudy,tests}' else '{}'::jsonb end) test
      cross join(values('all'),('sizheng'),('xuexitong'),('common')) bank(name)
      join totals on totals.dimension='chapter' and test.key=bank.name||':'||totals.label
      where s.account_id in(actor,peer) and s.kind='session' and s.record_key='resume'
      union all
      select s.account_id,s.payload->>'bank',s.payload->>'chapter',s.payload,
        case when s.payload->>'completedAt' ~ '^[0-9]{1,13}$' then (s.payload->>'completedAt')::bigint else s.revision end,s.revision
      from public.quiz_state s
      where s.account_id in(actor,peer) and s.kind='test' and s.payload->>'bank' in('all','sizheng','xuexitong','common')
        and exists(select 1 from catalog where chapter=s.payload->>'chapter')
    ), parsed_tests as (
      select *,case when value->>'correct' ~ '^[0-9]{1,5}$' then (value->>'correct')::integer end as correct,
        case when value->>'total' ~ '^[0-9]{1,5}$' then (value->>'total')::integer end as total
      from test_candidates
    ), latest_tests as (
      select distinct on(account_id,bank,chapter) account_id,bank,chapter,
        jsonb_build_object('bank',bank,'chapter',chapter,'correct',correct,'total',total) as row
      from parsed_tests where total>0 and correct<=total
      order by account_id,bank,chapter,observed_at desc,revision desc
    ) select jsonb_build_object(
      'historyBasis','recorded_attempts_with_legacy_snapshot',
      'days',(select jsonb_agg(jsonb_build_object('date',to_char(today-series.day_offset,'YYYY-MM-DD'),
        'mine',coalesce(daily.mine,0),'mineCorrect',coalesce(daily.mine_correct,0),
        'peer',coalesce(daily.theirs,0),'peerCorrect',coalesce(daily.theirs_correct,0)) order by series.day_offset)
        from generate_series(0,6) series(day_offset) left join daily on daily.day=today-series.day_offset),
      'chapters',coalesce((select jsonb_agg(row order by label) from rollups where dimension='chapter'),'[]'::jsonb),
      'types',coalesce((select jsonb_agg(row order by label) from rollups where dimension='type'),'[]'::jsonb),
      'tests',(select jsonb_build_object(
        'mine',coalesce(jsonb_agg(row order by bank,chapter) filter(where account_id=actor),'[]'::jsonb),
        'peer',coalesce(jsonb_agg(row order by bank,chapter) filter(where account_id=peer),'[]'::jsonb)) from latest_tests)
    )
  );
end;
$$;

create or replace function quiz_pk_private.leaderboard_today()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  actor uuid:=quiz_pk_private.require_member();
  study_day date:=(statement_timestamp() at time zone 'Asia/Shanghai')::date;
  start_ms bigint:=(extract(epoch from(study_day::timestamp at time zone 'Asia/Shanghai'))*1000)::bigint;
begin
  return (
    with eligible as (
      select account_id,nickname from quiz_pk_private.leaderboard_profiles
      union all select actor,null::text where not exists(select 1 from quiz_pk_private.leaderboard_profiles where account_id=actor)
    ), activity as (
      select a.account_id,count(distinct a.canonical_question_id) as answered
      from eligible join quiz_sync_private.attempts a using(account_id)
      where a.occurred_at>=start_ms and a.occurred_at<start_ms+86400000 group by a.account_id
    ), ranking as (
      select eligible.account_id,nickname,answered,rank() over(order by answered desc) as position
      from eligible join activity using(account_id) where nickname is not null
    ) select jsonb_build_object(
      'day',to_char(study_day,'YYYY-MM-DD'),'answerBasis','distinct_canonical_questions',
      'entries',coalesce((select jsonb_agg(jsonb_build_object('nickname',nickname,'rank',position,'answered',answered,'isMe',account_id=actor)
        order by position,nickname,account_id) from ranking),'[]'::jsonb),
      'me',(select jsonb_build_object('joined',eligible.nickname is not null,'nickname',eligible.nickname,
        'answered',coalesce(activity.answered,0),'rank',ranking.position)
        from eligible left join activity using(account_id) left join ranking using(account_id) where eligible.account_id=actor)
    )
  );
end;
$$;

create or replace function quiz_pk_private.social_daily(
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

    select count(distinct progress.canonical_question_id) filter (where progress.account_id = actor),
      count(distinct progress.canonical_question_id) filter (where progress.account_id = partner)
      into my_practiced, partner_practiced
      from quiz_sync_private.attempts progress
      where progress.account_id in (actor, partner)
        and progress.occurred_at >= start_ms and progress.occurred_at < end_ms;

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


create or replace function quiz_pk_private.dashboard()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
  current_pair quiz_pk_private.pairs;
  partner uuid;
  progress_peer uuid := quiz_pk_private.admin_progress_peer();
  latest_game quiz_pk_private.duels;
  past_games jsonb := '[]'::jsonb;
  total_questions bigint;
begin
  select p.* into current_pair
    from quiz_pk_private.active_pair_members as m
    join quiz_pk_private.pairs as p on p.id = m.pair_id
    where m.account_id = actor and p.closed_at is null;
  select count(*) into total_questions from quiz_pk_private.questions where answerable and question_id=canonical_question_id;

  if current_pair.id is not null then
    partner := case when current_pair.first_account = actor then current_pair.second_account
      else current_pair.first_account end;
    select d.* into latest_game from quiz_pk_private.duels as d
      where d.pair_id = current_pair.id
      order by d.created_at desc, d.id desc limit 1;

    select coalesce(jsonb_agg(quiz_pk_private.duel_summary(prior.game, actor)
      order by (prior.game).created_at desc, (prior.game).id desc), '[]'::jsonb) into past_games
      from (
        select d as game from quiz_pk_private.duels as d
        where d.pair_id = current_pair.id and d.id <> latest_game.id
          and exists (select 1 from quiz_pk_private.scores as s where s.duel_id = d.id and s.account_id = actor)
        order by d.created_at desc, d.id desc
      ) as prior;
  end if;

  return jsonb_build_object(
    'total', total_questions, 'me', quiz_pk_private.study_stats(actor, total_questions),
    'partner', case when partner is not null then quiz_pk_private.study_stats(partner, total_questions) end,
    'progressPeer', case when progress_peer is not null and progress_peer is distinct from partner then (
      select jsonb_object_agg(key, value)
      from jsonb_each(quiz_pk_private.study_stats(progress_peer, total_questions))
      where key in ('answered', 'correct', 'today', 'accuracy', 'completion')
    ) end,
    'invite', null, 'history', past_games,
    'duel', case when latest_game.id is not null then quiz_pk_private.duel_summary(latest_game, actor) end
  );
end;
$$;
