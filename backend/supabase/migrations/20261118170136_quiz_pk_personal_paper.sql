alter table quiz_pk_private.scores
  add column selected_answers jsonb
  check (selected_answers is null or
    (jsonb_typeof(selected_answers) = 'object' and octet_length(selected_answers::text) <= 10000));

-- Share a submitted paper only with its author. Older clients still use the
-- separately gated missedIds field when they display correct answers.
create or replace function quiz_pk_private.duel_summary(game quiz_pk_private.duels, actor uuid)
returns jsonb
language sql
set search_path = ''
as $$
  with results as (
    select
      (select s from quiz_pk_private.scores as s where s.duel_id = game.id and s.account_id = actor) as mine,
      (select s from quiz_pk_private.scores as s where s.duel_id = game.id and s.account_id <> actor) as theirs,
      cardinality(game.question_ids) as total
  )
  select jsonb_build_object(
    'id', game.id, 'createdAt', game.created_at, 'expiresAt', game.expires_at,
    'initiatedByMe', game.created_by = actor, 'chapter', game.chapter,
    'questionIds', game.question_ids,
    'own', case when (mine).account_id is not null then jsonb_build_object(
      'correct', (mine).correct, 'submittedAt', (mine).submitted_at, 'total', total,
      'paper', jsonb_build_object('missedIds', (mine).missed_ids, 'picks', (mine).selected_answers),
      'missedIds', case when (theirs).account_id is not null or game.expires_at <= clock_timestamp()
        then (mine).missed_ids end) end,
    'opponentSubmitted', (theirs).account_id is not null,
    'opponent', case when (mine).account_id is not null and (theirs).account_id is not null then jsonb_build_object(
      'correct', (theirs).correct, 'submittedAt', (theirs).submitted_at, 'total', total) end,
    'result', case when (mine).account_id is not null and (theirs).account_id is not null then
      case when (mine).correct > (theirs).correct then 'win'
        when (mine).correct < (theirs).correct then 'loss' else 'tie' end end,
    'status', case when (mine).account_id is not null and (theirs).account_id is not null then 'complete'
      when game.expires_at <= clock_timestamp() then 'expired' else 'open' end
  ) from results
$$;

create or replace function quiz_pk_private.submit_duel(target_duel uuid, answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
  current_pair_id uuid := quiz_pk_private.lock_pair(actor);
  game quiz_pk_private.duels;
  question quiz_pk_private.questions;
  chosen_id text;
  selection jsonb;
  selected_options text[];
  valid_options boolean;
  right_count integer := 0;
  missed_ids text[] := '{}'::text[];
  answer_count integer;
  submitted_at timestamptz := clock_timestamp();
begin
  select d.* into game from quiz_pk_private.duels as d where d.id = target_duel and d.pair_id = current_pair_id;
  if game.id is null then
    raise exception 'pk_duel_unavailable' using errcode = '42501';
  elsif exists (select 1 from quiz_pk_private.scores as s where s.duel_id = target_duel and s.account_id = actor) then
    return quiz_pk_private.dashboard();
  elsif game.expires_at <= submitted_at then
    raise exception 'pk_duel_expired';
  end if;
  if jsonb_typeof(answers) is distinct from 'object' or octet_length(answers::text) > 10000 then
    raise exception 'pk_invalid_answers' using errcode = '22023';
  end if;
  select count(*) into answer_count from jsonb_object_keys(answers);
  if answer_count <> cardinality(game.question_ids) then
    raise exception 'pk_invalid_answers' using errcode = '22023';
  end if;

  foreach chosen_id in array game.question_ids loop
    select q.* into question from quiz_pk_private.questions as q where q.question_id = chosen_id;
    selection := answers -> chosen_id;
    if jsonb_typeof(selection) is distinct from 'array' then
      raise exception 'pk_invalid_answers' using errcode = '22023';
    end if;

    select coalesce(array_agg(entry.value #>> '{}' order by entry.value #>> '{}'), '{}'::text[]),
      coalesce(bool_and(jsonb_typeof(entry.value) = 'string' and
        (entry.value #>> '{}') = any(question.options)), true)
      and count(*) = count(distinct entry.value)
      into selected_options, valid_options
      from jsonb_array_elements(selection) as entry(value);
    if not valid_options then
      raise exception 'pk_invalid_answers' using errcode = '22023';
    elsif selected_options = question.correct_options then
      right_count := right_count + 1;
    else
      missed_ids := array_append(missed_ids, chosen_id);
    end if;
  end loop;

  insert into quiz_pk_private.scores (duel_id, account_id, correct, missed_ids, submitted_at, selected_answers)
    values (game.id, actor, right_count, missed_ids, submitted_at, answers);
  return quiz_pk_private.dashboard();
end;
$$;
