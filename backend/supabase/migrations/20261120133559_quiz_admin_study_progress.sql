-- A directed, server-provisioned permission to read one learner's aggregate progress.
-- Do not provision real account identifiers in version control.
create table quiz_pk_private.admin_progress_access (
  admin_account uuid primary key references public.quiz_members(account_id) on delete cascade,
  peer_account uuid not null references public.quiz_members(account_id) on delete cascade,
  check (admin_account <> peer_account)
);

alter table quiz_pk_private.admin_progress_access enable row level security;
revoke all on table quiz_pk_private.admin_progress_access from public, anon, authenticated;

create function quiz_pk_private.admin_progress_peer()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select binding.peer_account
  from quiz_pk_private.admin_progress_access binding
  where binding.admin_account = auth.uid()
$$;

revoke execute on function quiz_pk_private.admin_progress_peer() from public, anon, authenticated;

-- Only the member-checked wrappers below may select the accounts used for aggregation.
create function quiz_pk_private.progress_rollups(actor uuid, peer uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  today date := (statement_timestamp() at time zone 'Asia/Shanghai')::date;
  first_ms bigint := (extract(epoch from ((today - 6)::timestamp at time zone 'Asia/Shanghai')) * 1000)::bigint;
  end_ms bigint := (extract(epoch from ((today + 1)::timestamp at time zone 'Asia/Shanghai')) * 1000)::bigint;
begin
  return (
    with catalog as (
      select question_id, chapter, coalesce(question_type, '未分类') as question_type
      from quiz_pk_private.questions
    ), dimensions as (
      select question_id, 'chapter' as dimension, chapter as label from catalog
      union all
      select question_id, 'type', question_type from catalog
    ), totals as (
      select dimension, label, count(*) as total
      from dimensions
      group by dimension, label
    ), attempts as (
      select history.account_id, catalog.question_id,
        jsonb_typeof(history.payload->'wrong') = 'boolean' as answered,
        history.payload->'wrong' = 'false'::jsonb as correct,
        case when jsonb_typeof(history.payload->'review') = 'boolean'
          then history.payload->'review' = 'true'::jsonb
          else history.payload->'wrong' = 'true'::jsonb end as review,
        case when history.payload->>'last' ~ '^[0-9]{1,13}$'
          then (history.payload->>'last')::bigint end as last_ms
      from public.quiz_state history
      join catalog on catalog.question_id = history.record_key
      where history.account_id in (actor, peer) and history.kind = 'history'
    ), daily as (
      select (to_timestamp(last_ms / 1000.0) at time zone 'Asia/Shanghai')::date as day,
        count(*) filter (where account_id = actor) as mine,
        count(*) filter (where account_id = actor and correct) as mine_correct,
        count(*) filter (where account_id = peer) as theirs,
        count(*) filter (where account_id = peer and correct) as theirs_correct
      from attempts
      where answered and last_ms >= first_ms and last_ms < end_ms
      group by 1
    ), activity as (
      select dimension, label,
        count(*) filter (where account_id = actor and answered) as mine,
        count(*) filter (where account_id = actor and correct) as mine_correct,
        count(*) filter (where account_id = actor and review) as mine_review,
        count(*) filter (where account_id = peer and answered) as theirs,
        count(*) filter (where account_id = peer and correct) as theirs_correct,
        count(*) filter (where account_id = peer and review) as theirs_review
      from attempts join dimensions using (question_id)
      group by dimension, label
    ), rollups as (
      select totals.dimension, totals.label, jsonb_build_object(
        totals.dimension, totals.label, 'total', totals.total,
        'mine', coalesce(activity.mine, 0), 'mineCorrect', coalesce(activity.mine_correct, 0),
        'mineReview', coalesce(activity.mine_review, 0),
        'peer', coalesce(activity.theirs, 0), 'peerCorrect', coalesce(activity.theirs_correct, 0),
        'peerReview', coalesce(activity.theirs_review, 0)
      ) as row
      from totals left join activity using (dimension, label)
    ), test_scores as (
      select session.account_id, bank.name as bank, totals.label as chapter,
        case when jsonb_typeof(test.value->'correct') = 'number'
          and test.value->>'correct' ~ '^[0-9]{1,5}$' then (test.value->>'correct')::integer end as correct,
        case when jsonb_typeof(test.value->'total') = 'number'
          and test.value->>'total' ~ '^[0-9]{1,5}$' then (test.value->>'total')::integer end as total
      from public.quiz_state session
      cross join lateral jsonb_each(case
        when jsonb_typeof(session.payload #> '{chapterStudy,tests}') = 'object'
        then session.payload #> '{chapterStudy,tests}' else '{}'::jsonb end) test
      cross join (values ('all'), ('sizheng'), ('xuexitong'), ('common')) bank(name)
      join totals on totals.dimension = 'chapter' and test.key = bank.name || ':' || totals.label
      where session.account_id in (actor, peer) and session.kind = 'session' and session.record_key = 'resume'
    ), valid_tests as (
      select account_id, bank, chapter, jsonb_build_object(
        'bank', bank, 'chapter', chapter, 'correct', correct, 'total', total
      ) as row
      from test_scores
      where total > 0 and correct <= total
    )
    select jsonb_build_object(
      'days', (
        select jsonb_agg(jsonb_build_object(
          'date', to_char(today - series.day_offset, 'YYYY-MM-DD'),
          'mine', coalesce(daily.mine, 0), 'mineCorrect', coalesce(daily.mine_correct, 0),
          'peer', coalesce(daily.theirs, 0), 'peerCorrect', coalesce(daily.theirs_correct, 0)
        ) order by series.day_offset)
        from generate_series(0, 6) as series(day_offset)
        left join daily on daily.day = today - series.day_offset
      ),
      'chapters', coalesce((select jsonb_agg(row order by label) from rollups where dimension = 'chapter'), '[]'::jsonb),
      'types', coalesce((select jsonb_agg(row order by label) from rollups where dimension = 'type'), '[]'::jsonb),
      'tests', (select jsonb_build_object(
        'mine', coalesce(jsonb_agg(row order by bank, chapter) filter (where account_id = actor), '[]'::jsonb),
        'peer', coalesce(jsonb_agg(row order by bank, chapter) filter (where account_id = peer), '[]'::jsonb)
      ) from valid_tests)
    )
  );
end;
$$;

revoke execute on function quiz_pk_private.progress_rollups(uuid, uuid) from public, anon, authenticated;

-- Preserve the current partner endpoint and its response for existing clients.
create or replace function quiz_pk_private.paired_progress_details()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
  peer uuid;
begin
  select case when pair.first_account = actor then pair.second_account else pair.first_account end
    into peer
    from quiz_pk_private.active_pair_members member
    join quiz_pk_private.pairs pair on pair.id = member.pair_id
    where member.account_id = actor
      and actor in (pair.first_account, pair.second_account) and pair.closed_at is null;

  if peer is null then
    return jsonb_build_object('paired', false, 'days', '[]'::jsonb, 'chapters', '[]'::jsonb,
      'types', '[]'::jsonb, 'tests', '{"mine":[],"peer":[]}'::jsonb);
  end if;

  return quiz_pk_private.progress_rollups(actor, peer) || jsonb_build_object('paired', true);
end;
$$;

create function quiz_pk_private.admin_progress_details()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
  peer uuid := quiz_pk_private.admin_progress_peer();
begin
  if peer is null then
    return null;
  end if;

  return quiz_pk_private.progress_rollups(actor, peer) || jsonb_build_object('access', 'admin');
end;
$$;

create function public.quiz_pk_admin_progress()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select quiz_pk_private.admin_progress_details() $$;

revoke execute on function quiz_pk_private.admin_progress_details(), public.quiz_pk_admin_progress()
  from public, anon, authenticated;
grant execute on function quiz_pk_private.admin_progress_details(), public.quiz_pk_admin_progress()
  to authenticated;

-- Add a separate progress card without using this permission as a pairing relation.
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
  active_invite jsonb;
  latest_game quiz_pk_private.duels;
  past_games jsonb := '[]'::jsonb;
  total_questions bigint;
begin
  select p.* into current_pair
    from quiz_pk_private.active_pair_members as m
    join quiz_pk_private.pairs as p on p.id = m.pair_id
    where m.account_id = actor and p.closed_at is null;
  select count(*) into total_questions from quiz_pk_private.questions;

  if current_pair.id is null then
    select jsonb_build_object('code', i.code, 'expiresAt', i.expires_at) into active_invite
      from quiz_pk_private.invites as i
      where i.inviter = actor and i.expires_at > clock_timestamp();
  else
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
    'progressPeer', case when progress_peer is not null then (
      select jsonb_object_agg(key, value)
      from jsonb_each(quiz_pk_private.study_stats(progress_peer, total_questions))
      where key in ('answered', 'correct', 'today', 'accuracy', 'completion')
    ) end,
    'invite', active_invite, 'history', past_games,
    'duel', case when latest_game.id is not null then quiz_pk_private.duel_summary(latest_game, actor) end
  );
end;
$$;
