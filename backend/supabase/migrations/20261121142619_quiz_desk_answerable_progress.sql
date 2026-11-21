-- The newer attempt-based backend already uses answerable canonical questions.
do $migration$
begin
  if to_regprocedure('public.quiz_sync_v2(uuid,jsonb,jsonb,bigint,integer)') is not null then return; end if;
create view quiz_pk_private.desk_answerable_questions as
select q.question_id, q.chapter, q.question_type, coalesce(alias.canonical_id, q.question_id) as canonical_id
from quiz_pk_private.questions q
left join (values
  ('章节自测-第十四章-单选-4', '第十四章-3'),
  ('章节自测-第十五章-单选-1', '第十五章-4'),
  ('章节自测-第十五章-单选-4', '第十五章-5')
) alias(question_id, canonical_id) using (question_id)
where q.question_type is distinct from '填空';

create view quiz_pk_private.desk_answerable_history as
select distinct on (s.account_id, q.canonical_id)
  s.account_id, q.canonical_id as record_key, s.kind, s.payload
from public.quiz_state s
join quiz_pk_private.desk_answerable_questions q on q.question_id = s.record_key
where s.kind = 'history'
order by s.account_id, q.canonical_id,
  (jsonb_typeof(s.payload->'wrong') = 'boolean') desc nulls last,
  (case when s.payload->>'last' ~ '^[0-9]{1,13}$' then (s.payload->>'last')::bigint end) desc nulls last,
  (q.question_id = q.canonical_id) desc, q.question_id;

execute $definition$
CREATE OR REPLACE FUNCTION quiz_pk_private.dashboard()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  select count(*) into total_questions from quiz_pk_private.desk_answerable_questions where question_id = canonical_id;

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
$function$;
$definition$;
execute $definition$
CREATE OR REPLACE FUNCTION quiz_pk_private.progress_rollups(actor uuid, peer uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  today date := (statement_timestamp() at time zone 'Asia/Shanghai')::date;
  first_ms bigint := (extract(epoch from ((today - 6)::timestamp at time zone 'Asia/Shanghai')) * 1000)::bigint;
  end_ms bigint := (extract(epoch from ((today + 1)::timestamp at time zone 'Asia/Shanghai')) * 1000)::bigint;
begin
  return (
    with catalog as (
      select question_id, chapter, coalesce(question_type, '未分类') as question_type
      from quiz_pk_private.desk_answerable_questions where question_id = canonical_id
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
      from quiz_pk_private.desk_answerable_history history
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
$function$;
$definition$;
execute $definition$
CREATE OR REPLACE FUNCTION quiz_pk_private.study_stats(account uuid, total_questions bigint)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  with daily as (
    select extract(epoch from (
      date_trunc('day', statement_timestamp() at time zone 'Asia/Shanghai')
        at time zone 'Asia/Shanghai'
    )) * 1000 as start_ms
  ), stats as (
    select count(*) as answered,
      count(*) filter (where s.payload->'wrong' = 'false'::jsonb) as correct,
      count(*) filter (where case when (s.payload->>'last') ~ '^[0-9]{1,13}$'
        then (s.payload->>'last')::bigint >= daily.start_ms
          and (s.payload->>'last')::bigint < daily.start_ms + 86400000
        else false end) as today
    from quiz_pk_private.desk_answerable_history as s
    cross join daily
    where s.account_id = account and s.kind = 'history'
      and jsonb_typeof(s.payload->'wrong') = 'boolean'
  )
  select jsonb_build_object(
    'answered', answered, 'correct', correct, 'today', today,
    'accuracy', coalesce(round(100.0 * correct / nullif(answered, 0)), 0),
    'completion', coalesce(round(100.0 * answered / nullif(total_questions, 0)), 0),
    'avatar', (
      select jsonb_build_object('path', image.name, 'revision', image.updated_at)
      from storage.objects as image
      where image.bucket_id = 'quiz-pk-avatars' and image.name = account::text || '.jpg'
    )
  ) from stats
$function$;
$definition$;
end;
$migration$;

