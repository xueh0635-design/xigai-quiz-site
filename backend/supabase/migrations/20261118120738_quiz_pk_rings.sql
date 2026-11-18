create schema quiz_pk_private;
revoke all on schema quiz_pk_private from public, anon, authenticated;

-- Only the database grades duels. All question IDs count toward completion;
-- objective questions with a canonical option set can appear in a duel.
create table quiz_pk_private.questions (
  question_id text primary key,
  chapter text not null,
  options text[],
  correct_options text[],
  check (
    (options is null and correct_options is null) or
    (options is not null and correct_options is not null
      and cardinality(correct_options) between 1 and cardinality(options)
      and correct_options <@ options)
  )
);

create table quiz_pk_private.invites (
  inviter uuid primary key references public.quiz_members(account_id) on delete cascade,
  code text not null unique check (code ~ '^[A-F0-9]{16}$'),
  expires_at timestamptz not null
);

create table quiz_pk_private.pairs (
  id uuid primary key default gen_random_uuid(),
  first_account uuid not null references public.quiz_members(account_id) on delete cascade,
  second_account uuid not null references public.quiz_members(account_id) on delete cascade,
  closed_at timestamptz,
  check (first_account < second_account)
);

-- The primary key gives each account at most one active partner.
create table quiz_pk_private.active_pair_members (
  account_id uuid primary key references public.quiz_members(account_id) on delete cascade,
  pair_id uuid not null references quiz_pk_private.pairs(id) on delete cascade
);

create table quiz_pk_private.duels (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references quiz_pk_private.pairs(id) on delete cascade,
  created_by uuid not null references public.quiz_members(account_id) on delete cascade,
  chapter text,
  question_ids text[] not null check (cardinality(question_ids) = 10),
  created_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > created_at)
);
create index quiz_pk_duels_recent on quiz_pk_private.duels (pair_id, created_at desc, id desc);

create table quiz_pk_private.scores (
  duel_id uuid not null references quiz_pk_private.duels(id) on delete cascade,
  account_id uuid not null references public.quiz_members(account_id) on delete cascade,
  correct smallint not null check (correct between 0 and 10),
  missed_ids text[] not null check (cardinality(missed_ids) = 10 - correct),
  submitted_at timestamptz not null,
  primary key (duel_id, account_id)
);

alter table quiz_pk_private.questions enable row level security;
alter table quiz_pk_private.invites enable row level security;
alter table quiz_pk_private.pairs enable row level security;
alter table quiz_pk_private.active_pair_members enable row level security;
alter table quiz_pk_private.duels enable row level security;
alter table quiz_pk_private.scores enable row level security;

revoke all on all tables in schema quiz_pk_private from public, anon, authenticated;

create function quiz_pk_private.require_member()
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not exists (select 1 from public.quiz_members as m where m.account_id = actor) then
    raise exception 'pk_membership_required' using errcode = '42501';
  end if;
  return actor;
end;
$$;

create function quiz_pk_private.study_stats(account uuid, total_questions bigint)
returns jsonb
language sql
set search_path = ''
as $$
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
    from public.quiz_state as s
    join quiz_pk_private.questions as q on q.question_id = s.record_key
    cross join daily
    where s.account_id = account and s.kind = 'history'
      and jsonb_typeof(s.payload->'wrong') = 'boolean'
  )
  select jsonb_build_object(
    'answered', answered, 'correct', correct, 'today', today,
    'accuracy', coalesce(round(100.0 * correct / nullif(answered, 0)), 0),
    'completion', coalesce(round(100.0 * answered / nullif(total_questions, 0)), 0)
  ) from stats
$$;

create function quiz_pk_private.duel_summary(game quiz_pk_private.duels, actor uuid)
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
    'own', case when mine is not null then jsonb_build_object(
      'correct', (mine).correct, 'submittedAt', (mine).submitted_at, 'total', total,
      'missedIds', case when theirs is not null or game.expires_at <= clock_timestamp()
        then (mine).missed_ids end) end,
    'opponentSubmitted', theirs is not null,
    'opponent', case when mine is not null and theirs is not null then jsonb_build_object(
      'correct', (theirs).correct, 'submittedAt', (theirs).submitted_at, 'total', total) end,
    'result', case when mine is not null and theirs is not null then
      case when (mine).correct > (theirs).correct then 'win'
        when (mine).correct < (theirs).correct then 'loss' else 'tie' end end,
    'status', case when mine is not null and theirs is not null then 'complete'
      when game.expires_at <= clock_timestamp() then 'expired' else 'open' end
  ) from results
$$;

create function quiz_pk_private.dashboard()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
  current_pair quiz_pk_private.pairs;
  partner uuid;
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
          and (select count(*) from quiz_pk_private.scores as s where s.duel_id = d.id) = 2
        order by d.created_at desc, d.id desc limit 5
      ) as prior;
  end if;

  return jsonb_build_object(
    'total', total_questions, 'me', quiz_pk_private.study_stats(actor, total_questions),
    'partner', case when partner is not null then quiz_pk_private.study_stats(partner, total_questions) end,
    'invite', active_invite, 'history', past_games,
    'duel', case when latest_game.id is not null then quiz_pk_private.duel_summary(latest_game, actor) end
  );
end;
$$;

create function quiz_pk_private.create_invite()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
begin
  -- Pair mutations serialize so that two different invite codes cannot assign
  -- the same account to different partners.
  perform pg_advisory_xact_lock(hashtext('quiz_pk_pairing'));
  if exists (select 1 from quiz_pk_private.active_pair_members as m where m.account_id = actor) then
    raise exception 'pk_already_paired';
  end if;

  insert into quiz_pk_private.invites as previous (inviter, code, expires_at)
    values (actor, upper(left(replace(gen_random_uuid()::text, '-', ''), 16)),
      clock_timestamp() + interval '24 hours')
    on conflict (inviter) do update set code = excluded.code, expires_at = excluded.expires_at
    where previous.expires_at <= clock_timestamp();
  return quiz_pk_private.dashboard();
end;
$$;

create function quiz_pk_private.join_pair(invite_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
  normalized_code text := upper(regexp_replace(invite_code, '[-[:space:]]', '', 'g'));
  inviter_id uuid;
  new_pair_id uuid;
begin
  if normalized_code is null or normalized_code !~ '^[A-F0-9]{16}$' then
    raise exception 'pk_invite_unavailable' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('quiz_pk_pairing'));
  select i.inviter into inviter_id
    from quiz_pk_private.invites as i
    where i.code = normalized_code and i.expires_at > clock_timestamp();
  if inviter_id is null then
    raise exception 'pk_invite_unavailable';
  elsif inviter_id = actor then
    raise exception 'pk_cannot_join_own_invite';
  elsif exists (select 1 from quiz_pk_private.active_pair_members as m where m.account_id in (actor, inviter_id)) then
    raise exception 'pk_already_paired';
  end if;

  insert into quiz_pk_private.pairs (first_account, second_account)
    values (least(actor, inviter_id), greatest(actor, inviter_id)) returning id into new_pair_id;
  insert into quiz_pk_private.active_pair_members (account_id, pair_id)
    values (actor, new_pair_id), (inviter_id, new_pair_id);
  delete from quiz_pk_private.invites as i where i.inviter in (actor, inviter_id);
  return quiz_pk_private.dashboard();
end;
$$;

create function quiz_pk_private.leave_pair()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
  closing_pair_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('quiz_pk_pairing'));
  select m.pair_id into closing_pair_id from quiz_pk_private.active_pair_members as m where m.account_id = actor;
  if closing_pair_id is not null then
    -- Lock the same pair row as start and submit before revoking both memberships.
    update quiz_pk_private.pairs as p set closed_at = clock_timestamp() where p.id = closing_pair_id;
    delete from quiz_pk_private.active_pair_members as m where m.pair_id = closing_pair_id;
  else
    delete from quiz_pk_private.invites as i where i.inviter = actor;
  end if;
  return quiz_pk_private.dashboard();
end;
$$;

create function quiz_pk_private.lock_pair(actor uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  current_pair_id uuid;
begin
  select p.id into current_pair_id
    from quiz_pk_private.active_pair_members as m
    join quiz_pk_private.pairs as p on p.id = m.pair_id
    where m.account_id = actor and p.closed_at is null for update of p;
  if current_pair_id is null then
    raise exception 'pk_pair_required' using errcode = '42501';
  end if;
  return current_pair_id;
end;
$$;

create function quiz_pk_private.start_duel(requested_chapter text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
  current_pair_id uuid := quiz_pk_private.lock_pair(actor);
  actual_chapter text := nullif(btrim(requested_chapter), '');
  selected_questions text[];
  opened_at timestamptz;
begin
  if exists (
    select 1 from quiz_pk_private.duels as d
    where d.pair_id = current_pair_id and d.expires_at > clock_timestamp()
      and (select count(*) from quiz_pk_private.scores as s where s.duel_id = d.id) < 2
  ) then
    return quiz_pk_private.dashboard();
  end if;

  select array(
    select q.question_id from quiz_pk_private.questions as q
    where q.correct_options is not null and (actual_chapter is null or q.chapter = actual_chapter)
    order by random() limit 10
  ) into selected_questions;
  if cardinality(selected_questions) <> 10 then
    raise exception 'pk_chapter_unavailable' using errcode = '22023';
  end if;
  opened_at := clock_timestamp();
  insert into quiz_pk_private.duels (pair_id, created_by, chapter, question_ids, created_at, expires_at)
    values (current_pair_id, actor, actual_chapter, selected_questions, opened_at, opened_at + interval '72 hours');
  return quiz_pk_private.dashboard();
end;
$$;

create function quiz_pk_private.submit_duel(target_duel uuid, answers jsonb)
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

  insert into quiz_pk_private.scores (duel_id, account_id, correct, missed_ids, submitted_at)
    values (game.id, actor, right_count, missed_ids, submitted_at);
  return quiz_pk_private.dashboard();
end;
$$;

-- Only these SDK-facing invoker wrappers are in the exposed schema.
-- Their private implementations all derive the actor from the authenticated JWT.
create function public.quiz_pk_dashboard()
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.dashboard() $$;

create function public.quiz_pk_create_invite()
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.create_invite() $$;

create function public.quiz_pk_join(invite_code text)
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.join_pair(invite_code) $$;

create function public.quiz_pk_unpair()
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.leave_pair() $$;

create function public.quiz_pk_start(chapter text default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.start_duel(chapter) $$;

create function public.quiz_pk_submit(duel_id uuid, answers jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.submit_duel(duel_id, answers) $$;

revoke execute on all functions in schema quiz_pk_private from public, anon, authenticated;
grant usage on schema quiz_pk_private to authenticated;
grant execute on function quiz_pk_private.dashboard(), quiz_pk_private.create_invite(),
  quiz_pk_private.join_pair(text), quiz_pk_private.leave_pair(), quiz_pk_private.start_duel(text),
  quiz_pk_private.submit_duel(uuid, jsonb) to authenticated;

revoke execute on function public.quiz_pk_dashboard(), public.quiz_pk_create_invite(),
  public.quiz_pk_join(text), public.quiz_pk_unpair(), public.quiz_pk_start(text),
  public.quiz_pk_submit(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.quiz_pk_dashboard(), public.quiz_pk_create_invite(),
  public.quiz_pk_join(text), public.quiz_pk_unpair(), public.quiz_pk_start(text),
  public.quiz_pk_submit(uuid, jsonb) to authenticated;

-- Snapshot of the 1,221 reviewed questions used by this build.
insert into quiz_pk_private.questions (question_id, chapter, options, correct_options) values
  ('新增（必刷）-1', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-2', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-3', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-4', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-5', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-6', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-7', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-8', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-9', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-10', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-11', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-12', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-13', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-14', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-15', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-16', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-17', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-18', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-19', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-20', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-21', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-22', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-23', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-24', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-25', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-26', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-27', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-28', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-29', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-30', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-31', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-32', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-33', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-34', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-35', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-36', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-37', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-38', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-39', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-40', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-41', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-42', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-43', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-44', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-45', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-46', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-47', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-48', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-49', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-50', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-51', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-52', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-53', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-54', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-55', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-56', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-57', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-58', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-59', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-60', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-61', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-62', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-63', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-64', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-65', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-66', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-67', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-68', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-69', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-70', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-71', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-72', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-73', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-74', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-75', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-76', '新增（必刷）', array['A','B','C','D'], array['A']),
  ('新增（必刷）-77', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-78', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-79', '新增（必刷）', array['A','B','C','D'], array['C']),
  ('新增（必刷）-80', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-81', '新增（必刷）', array['A','B','C','D'], array['D']),
  ('新增（必刷）-82', '新增（必刷）', array['A','B','C','D'], array['B']),
  ('新增（必刷）-83', '新增（必刷）', array['A','B','C','D'], array['A','B','D']),
  ('新增（必刷）-84', '新增（必刷）', array['A','B','C','D'], array['A','C','D']),
  ('新增（必刷）-85', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-86', '新增（必刷）', array['A','B','C','D'], array['A','C','D']),
  ('新增（必刷）-87', '新增（必刷）', array['A','B','C','D'], array['A','B','C']),
  ('新增（必刷）-88', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-89', '新增（必刷）', array['A','B','C','D'], array['A','D']),
  ('新增（必刷）-90', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-91', '新增（必刷）', array['A','B','C','D'], array['A','B']),
  ('新增（必刷）-92', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-93', '新增（必刷）', array['A','B','C','D'], array['A','C','D']),
  ('新增（必刷）-94', '新增（必刷）', array['A','B','C','D'], array['A','B']),
  ('新增（必刷）-95', '新增（必刷）', array['A','B','C','D'], array['B','C','D']),
  ('新增（必刷）-96', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-97', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-98', '新增（必刷）', array['A','B','C','D'], array['A','B','C']),
  ('新增（必刷）-99', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-100', '新增（必刷）', array['A','B','C','D'], array['A','C','D']),
  ('新增（必刷）-101', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-102', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-103', '新增（必刷）', array['A','B','C','D'], array['A','B','C']),
  ('新增（必刷）-104', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-105', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-106', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-107', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-108', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-109', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-110', '新增（必刷）', array['A','B','C','D'], array['A','B','C','D']),
  ('新增（必刷）-111', '新增（必刷）', array['A','B'], array['A']),
  ('新增（必刷）-112', '新增（必刷）', array['A','B'], array['A']),
  ('新增（必刷）-113', '新增（必刷）', array['A','B'], array['A']),
  ('新增（必刷）-114', '新增（必刷）', array['A','B'], array['A']),
  ('新增（必刷）-115', '新增（必刷）', array['A','B'], array['A']),
  ('新增（必刷）-116', '新增（必刷）', array['A','B'], array['B']),
  ('新增（必刷）-117', '新增（必刷）', array['A','B'], array['B']),
  ('新增（必刷）-118', '新增（必刷）', array['A','B'], array['B']),
  ('新增（必刷）-119', '新增（必刷）', array['A','B'], array['A']),
  ('新增（必刷）-120', '新增（必刷）', array['A','B'], array['B']),
  ('新增（必刷）-121', '新增（必刷）', array['A','B'], array['A']),
  ('新增（必刷）-122', '新增（必刷）', array['A','B'], array['A']),
  ('新增（必刷）-123', '新增（必刷）', array['A','B'], array['B']),
  ('新增（必刷）-124', '新增（必刷）', array['A','B'], array['A']),
  ('新增（必刷）-125', '新增（必刷）', array['A','B'], array['B']),
  ('新增（必刷）-126', '新增（必刷）', array['A','B'], array['B']),
  ('导论-1', '导论', array['A','B','C','D'], array['A']),
  ('导论-2', '导论', array['A','B','C','D'], array['D']),
  ('导论-3', '导论', array['A','B','C','D'], array['B']),
  ('导论-4', '导论', array['A','B','C','D'], array['D']),
  ('导论-5', '导论', array['A','B','C','D'], array['B']),
  ('导论-6', '导论', array['A','B','C','D'], array['B']),
  ('导论-7', '导论', array['A','B','C','D'], array['D']),
  ('导论-8', '导论', array['A','B','C','D'], array['C']),
  ('导论-9', '导论', array['A','B','C','D'], array['A']),
  ('导论-10', '导论', array['A','B','C','D'], array['C']),
  ('导论-11', '导论', array['A','B','C','D'], array['B']),
  ('导论-12', '导论', array['A','B','C','D'], array['D']),
  ('导论-13', '导论', array['A','B','C','D'], array['A','B','C']),
  ('导论-14', '导论', array['A','B','C','D'], array['A','B','D']),
  ('导论-15', '导论', array['A','B','C','D'], array['A','B','C','D']),
  ('导论-16', '导论', array['A','B','C','D'], array['A','B']),
  ('导论-17', '导论', array['A','B','C','D'], array['A','B','C','D']),
  ('导论-18', '导论', array['A','B','C','D'], array['B','C','D']),
  ('导论-19', '导论', array['A','B','C','D'], array['A','B','C']),
  ('导论-20', '导论', array['A','B','C','D'], array['A','B','C','D']),
  ('导论-21', '导论', array['A','B','C','D'], array['A','B','C','D']),
  ('导论-22', '导论', array['A','B','C','D'], array['A','B','C','D']),
  ('导论-23', '导论', array['A','B','C','D'], array['A','B','C']),
  ('导论-24', '导论', array['A','B','C','D'], array['A','B','C','D']),
  ('导论-25', '导论', null, null),
  ('导论-26', '导论', null, null),
  ('导论-27', '导论', null, null),
  ('导论-28', '导论', null, null),
  ('导论-29', '导论', null, null),
  ('导论-30', '导论', null, null),
  ('导论-31', '导论', null, null),
  ('导论-32', '导论', array['A','B'], array['A']),
  ('导论-33', '导论', array['A','B'], array['A']),
  ('导论-34', '导论', array['A','B'], array['A']),
  ('导论-35', '导论', array['A','B'], array['A']),
  ('导论-36', '导论', array['A','B'], array['A']),
  ('导论-37', '导论', array['A','B'], array['A']),
  ('导论-38', '导论', array['A','B'], array['B']),
  ('导论-39', '导论', array['A','B'], array['A']),
  ('导论-40', '导论', array['A','B'], array['A']),
  ('导论-41', '导论', array['A','B'], array['A']),
  ('导论-42', '导论', array['A','B'], array['A']),
  ('导论-43', '导论', array['A','B'], array['A']),
  ('导论-44', '导论', array['A','B'], array['A']),
  ('导论-45', '导论', array['A','B'], array['A']),
  ('第一章-1', '第一章', array['A','B','C','D'], array['A']),
  ('第一章-2', '第一章', array['A','B','C','D'], array['D']),
  ('第一章-3', '第一章', array['A','B','C','D'], array['A']),
  ('第一章-4', '第一章', array['A','B','C','D'], array['B']),
  ('第一章-5', '第一章', array['A','B','C','D'], array['C']),
  ('第一章-6', '第一章', array['A','B','C','D'], array['D']),
  ('第一章-7', '第一章', array['A','B','C','D'], array['D']),
  ('第一章-8', '第一章', array['A','B','C','D'], array['B']),
  ('第一章-9', '第一章', array['A','B','C','D'], array['D']),
  ('第一章-10', '第一章', array['A','B','C','D'], array['A']),
  ('第一章-11', '第一章', array['A','B','C','D'], array['A']),
  ('第一章-12', '第一章', array['A','B','C','D'], array['C']),
  ('第一章-13', '第一章', array['A','B','C','D'], array['A']),
  ('第一章-14', '第一章', array['A','B','C','D'], array['D']),
  ('第一章-15', '第一章', array['A','B','C','D'], array['D']),
  ('第一章-16', '第一章', array['A','B','C','D'], array['C']),
  ('第一章-17', '第一章', array['A','B','C','D'], array['B']),
  ('第一章-18', '第一章', array['A','B','C','D'], array['D']),
  ('第一章-19', '第一章', array['A','B','C','D'], array['B']),
  ('第一章-20', '第一章', array['A','B','C','D'], array['B']),
  ('第一章-21', '第一章', array['A','B','C','D'], array['C']),
  ('第一章-22', '第一章', array['A','B','C','D'], array['D']),
  ('第一章-23', '第一章', array['A','B','C','D'], array['C']),
  ('第一章-24', '第一章', array['A','B','C','D'], array['B']),
  ('第一章-25', '第一章', array['A','B','C','D'], array['C']),
  ('第一章-26', '第一章', array['A','B','C','D'], array['A']),
  ('第一章-27', '第一章', array['A','B','C','D'], array['B']),
  ('第一章-28', '第一章', array['A','B','C','D'], array['B']),
  ('第一章-29', '第一章', array['A','B','C','D'], array['D']),
  ('第一章-30', '第一章', array['A','B','C','D'], array['A']),
  ('第一章-31', '第一章', array['A','B','C','D'], array['C']),
  ('第一章-32', '第一章', array['A','B','C','D'], array['A']),
  ('第一章-33', '第一章', array['A','B','C','D'], array['A']),
  ('第一章-34', '第一章', array['A','B','C','D'], array['B']),
  ('第一章-35', '第一章', array['A','B','C','D'], array['A']),
  ('第一章-36', '第一章', array['A','B','C','D'], array['B']),
  ('第一章-37', '第一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第一章-38', '第一章', array['A','B','C','D'], array['A','C']),
  ('第一章-39', '第一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第一章-40', '第一章', array['A','B','C','D'], array['A','B','C']),
  ('第一章-41', '第一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第一章-42', '第一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第一章-43', '第一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第一章-44', '第一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第一章-45', '第一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第一章-46', '第一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第一章-47', '第一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第一章-48', '第一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第一章-49', '第一章', null, null),
  ('第一章-50', '第一章', null, null),
  ('第一章-51', '第一章', null, null),
  ('第一章-52', '第一章', null, null),
  ('第一章-53', '第一章', array['A','B'], array['A']),
  ('第一章-54', '第一章', array['A','B'], array['A']),
  ('第一章-55', '第一章', array['A','B'], array['A']),
  ('第一章-56', '第一章', array['A','B'], array['B']),
  ('第一章-57', '第一章', array['A','B'], array['A']),
  ('第一章-58', '第一章', array['A','B'], array['A']),
  ('第一章-59', '第一章', array['A','B'], array['B']),
  ('第一章-60', '第一章', array['A','B'], array['A']),
  ('第一章-61', '第一章', array['A','B'], array['B']),
  ('第一章-62', '第一章', array['A','B'], array['A']),
  ('第一章-63', '第一章', array['A','B'], array['A']),
  ('第一章-64', '第一章', array['A','B'], array['A']),
  ('第一章-65', '第一章', array['A','B'], array['A']),
  ('第一章-66', '第一章', array['A','B'], array['B']),
  ('第二章-1', '第二章', array['A','B','C','D'], array['B']),
  ('第二章-2', '第二章', array['A','B','C','D'], array['D']),
  ('第二章-3', '第二章', array['A','B','C','D'], array['B']),
  ('第二章-4', '第二章', array['A','B','C','D'], array['C']),
  ('第二章-5', '第二章', array['A','B','C','D'], array['D']),
  ('第二章-6', '第二章', array['A','B','C','D'], array['B']),
  ('第二章-7', '第二章', array['A','B','C','D'], array['B']),
  ('第二章-8', '第二章', array['A','B','C','D'], array['A']),
  ('第二章-9', '第二章', array['A','B','C','D'], array['C']),
  ('第二章-10', '第二章', array['A','B','C','D'], array['C']),
  ('第二章-11', '第二章', array['A','B','C','D'], array['A']),
  ('第二章-12', '第二章', array['A','B','C','D'], array['C']),
  ('第二章-13', '第二章', array['A','B','C','D'], array['C']),
  ('第二章-14', '第二章', array['A','B','C','D'], array['B']),
  ('第二章-15', '第二章', array['A','B','C','D'], array['A']),
  ('第二章-16', '第二章', array['A','B','C','D'], array['D']),
  ('第二章-17', '第二章', array['A','B','C','D'], array['C']),
  ('第二章-18', '第二章', array['A','B','C','D'], array['A']),
  ('第二章-19', '第二章', array['A','B','C','D'], array['A']),
  ('第二章-20', '第二章', array['A','B','C','D'], array['D']),
  ('第二章-21', '第二章', array['A','B','C','D'], array['B']),
  ('第二章-22', '第二章', array['A','B','C','D'], array['A']),
  ('第二章-23', '第二章', array['A','B','C','D'], array['B']),
  ('第二章-24', '第二章', array['A','B','C','D'], array['C']),
  ('第二章-25', '第二章', array['A','B','C','D'], array['A']),
  ('第二章-26', '第二章', array['A','B','C','D'], array['B']),
  ('第二章-27', '第二章', array['A','B','C','D'], array['D']),
  ('第二章-28', '第二章', array['A','B','C','D'], array['C']),
  ('第二章-29', '第二章', array['A','B','C','D'], array['C']),
  ('第二章-30', '第二章', array['A','B','C','D'], array['D']),
  ('第二章-31', '第二章', array['A','B','C','D'], array['D']),
  ('第二章-32', '第二章', array['A','B','C','D'], array['D']),
  ('第二章-33', '第二章', array['A','B','C','D'], array['D']),
  ('第二章-34', '第二章', array['A','B','C','D'], array['D']),
  ('第二章-35', '第二章', array['A','B','C','D'], array['B']),
  ('第二章-36', '第二章', array['A','B','C','D'], array['A','B','C']),
  ('第二章-37', '第二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第二章-38', '第二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第二章-39', '第二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第二章-40', '第二章', array['A','B','C','D'], array['A','B']),
  ('第二章-41', '第二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第二章-42', '第二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第二章-43', '第二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第二章-44', '第二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第二章-45', '第二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第二章-46', '第二章', array['A','B','C','D'], array['A','C','D']),
  ('第二章-47', '第二章', null, null),
  ('第二章-48', '第二章', null, null),
  ('第二章-49', '第二章', null, null),
  ('第二章-50', '第二章', null, null),
  ('第二章-51', '第二章', null, null),
  ('第二章-52', '第二章', null, null),
  ('第二章-53', '第二章', null, null),
  ('第二章-54', '第二章', null, null),
  ('第二章-55', '第二章', null, null),
  ('第二章-56', '第二章', null, null),
  ('第二章-57', '第二章', array['A','B'], array['B']),
  ('第二章-58', '第二章', array['A','B'], array['B']),
  ('第二章-59', '第二章', array['A','B'], array['B']),
  ('第二章-60', '第二章', array['A','B'], array['B']),
  ('第二章-61', '第二章', array['A','B'], array['A']),
  ('第二章-62', '第二章', array['A','B'], array['A']),
  ('第二章-63', '第二章', array['A','B'], array['A']),
  ('第二章-64', '第二章', array['A','B'], array['B']),
  ('第二章-65', '第二章', array['A','B'], array['B']),
  ('第二章-66', '第二章', array['A','B'], array['A']),
  ('第二章-67', '第二章', array['A','B'], array['A']),
  ('第三章-1', '第三章', array['A','B','C','D'], array['B']),
  ('第三章-2', '第三章', array['A','B','C','D'], array['D']),
  ('第三章-3', '第三章', array['A','B','C','D'], array['A']),
  ('第三章-4', '第三章', array['A','B','C','D'], array['C']),
  ('第三章-5', '第三章', array['A','B','C','D'], array['A']),
  ('第三章-6', '第三章', array['A','B','C','D'], array['A']),
  ('第三章-7', '第三章', array['A','B','C','D'], array['B']),
  ('第三章-8', '第三章', array['A','B','C','D'], array['A']),
  ('第三章-9', '第三章', array['A','B','C','D'], array['B']),
  ('第三章-10', '第三章', array['A','B','C','D'], array['B']),
  ('第三章-11', '第三章', array['A','B','C','D'], array['D']),
  ('第三章-12', '第三章', array['A','B','C','D'], array['B']),
  ('第三章-13', '第三章', array['A','B','C','D'], array['C']),
  ('第三章-14', '第三章', array['A','B','C','D'], array['D']),
  ('第三章-15', '第三章', array['A','B','C','D'], array['D']),
  ('第三章-16', '第三章', array['A','B','C','D'], array['C']),
  ('第三章-17', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-18', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-19', '第三章', array['A','B','C','D'], array['A','B','C']),
  ('第三章-20', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-21', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-22', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-23', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-24', '第三章', array['A','B','C','D'], array['A','B','C']),
  ('第三章-25', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-26', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-27', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-28', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-29', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-30', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-31', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-32', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-33', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-34', '第三章', array['A','B','C','D'], array['A','B','C']),
  ('第三章-35', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-36', '第三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第三章-37', '第三章', null, null),
  ('第三章-38', '第三章', null, null),
  ('第三章-39', '第三章', null, null),
  ('第三章-40', '第三章', null, null),
  ('第三章-41', '第三章', array['A','B'], array['A']),
  ('第三章-42', '第三章', array['A','B'], array['A']),
  ('第三章-43', '第三章', array['A','B'], array['A']),
  ('第三章-44', '第三章', array['A','B'], array['A']),
  ('第三章-45', '第三章', array['A','B'], array['A']),
  ('第三章-46', '第三章', array['A','B'], array['A']),
  ('第三章-47', '第三章', array['A','B'], array['A']),
  ('第三章-48', '第三章', array['A','B'], array['A']),
  ('第三章-49', '第三章', array['A','B'], array['A']),
  ('第三章-50', '第三章', array['A','B'], array['A']),
  ('第三章-51', '第三章', array['A','B'], array['A']),
  ('第三章-52', '第三章', array['A','B'], array['A']),
  ('第四章-1', '第四章', array['A','B','C','D'], array['A']),
  ('第四章-2', '第四章', array['A','B','C','D'], array['B']),
  ('第四章-3', '第四章', array['A','B','C','D'], array['C']),
  ('第四章-4', '第四章', array['A','B','C','D'], array['C']),
  ('第四章-5', '第四章', array['A','B','C','D'], array['B']),
  ('第四章-6', '第四章', array['A','B','C','D'], array['D']),
  ('第四章-7', '第四章', array['A','B','C','D'], array['C']),
  ('第四章-8', '第四章', array['A','B','C','D'], array['B']),
  ('第四章-9', '第四章', array['A','B','C','D'], array['C']),
  ('第四章-10', '第四章', array['A','B','C','D'], array['B']),
  ('第四章-11', '第四章', array['A','B','C','D'], array['D']),
  ('第四章-12', '第四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第四章-13', '第四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第四章-14', '第四章', array['A','B','C','D'], array['A','B','C']),
  ('第四章-15', '第四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第四章-16', '第四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第四章-17', '第四章', array['A','B','C','D'], array['A','B','C']),
  ('第四章-18', '第四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第四章-19', '第四章', array['A','B','C','D'], array['A','C','D']),
  ('第四章-20', '第四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第四章-21', '第四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第四章-22', '第四章', array['A','B','C','D'], array['A','B','C']),
  ('第四章-23', '第四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第四章-24', '第四章', array['A','B','C','D'], array['A','B','C']),
  ('第四章-25', '第四章', null, null),
  ('第四章-26', '第四章', null, null),
  ('第四章-27', '第四章', null, null),
  ('第四章-28', '第四章', null, null),
  ('第四章-29', '第四章', null, null),
  ('第四章-30', '第四章', array['A','B'], array['A']),
  ('第四章-31', '第四章', array['A','B'], array['B']),
  ('第四章-32', '第四章', array['A','B'], array['A']),
  ('第四章-33', '第四章', array['A','B'], array['A']),
  ('第四章-34', '第四章', array['A','B'], array['A']),
  ('第四章-35', '第四章', array['A','B'], array['B']),
  ('第四章-36', '第四章', array['A','B'], array['A']),
  ('第四章-37', '第四章', array['A','B'], array['A']),
  ('第四章-38', '第四章', array['A','B'], array['A']),
  ('第四章-39', '第四章', array['A','B'], array['A']),
  ('第四章-40', '第四章', array['A','B'], array['A']),
  ('第四章-41', '第四章', array['A','B'], array['A']),
  ('第四章-42', '第四章', array['A','B'], array['A']),
  ('第四章-43', '第四章', array['A','B'], array['A']),
  ('第四章-44', '第四章', array['A','B'], array['A']),
  ('第四章-45', '第四章', array['A','B'], array['A']),
  ('第四章-46', '第四章', array['A','B'], array['B']),
  ('第四章-47', '第四章', array['A','B'], array['A']),
  ('第四章-48', '第四章', array['A','B'], array['B']),
  ('第四章-49', '第四章', array['A','B'], array['A']),
  ('第四章-50', '第四章', array['A','B'], array['A']),
  ('第四章-51', '第四章', array['A','B'], array['A']),
  ('第四章-52', '第四章', array['A','B'], array['A']),
  ('第四章-53', '第四章', array['A','B'], array['A']),
  ('第四章-54', '第四章', array['A','B'], array['A']),
  ('第四章-55', '第四章', array['A','B'], array['B']),
  ('第五章-1', '第五章', array['A','B','C','D'], array['B']),
  ('第五章-2', '第五章', array['A','B','C','D'], array['D']),
  ('第五章-3', '第五章', array['A','B','C','D'], array['D']),
  ('第五章-4', '第五章', array['A','B','C','D'], array['D']),
  ('第五章-5', '第五章', array['A','B','C','D'], array['D']),
  ('第五章-6', '第五章', array['A','B','C','D'], array['A']),
  ('第五章-7', '第五章', array['A','B','C','D'], array['C']),
  ('第五章-8', '第五章', array['A','B','C','D'], array['A']),
  ('第五章-9', '第五章', array['A','B','C','D'], array['D']),
  ('第五章-10', '第五章', array['A','B','C','D'], array['A']),
  ('第五章-11', '第五章', array['A','B','C','D'], array['B']),
  ('第五章-12', '第五章', array['A','B','C','D'], array['C']),
  ('第五章-13', '第五章', array['A','B','C','D'], array['B']),
  ('第五章-14', '第五章', array['A','B','C','D'], array['B']),
  ('第五章-15', '第五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第五章-16', '第五章', array['A','B','C','D'], array['A','C','D']),
  ('第五章-17', '第五章', array['A','B','C','D'], array['A','B','C']),
  ('第五章-18', '第五章', array['A','B','C','D'], array['B','C','D']),
  ('第五章-19', '第五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第五章-20', '第五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第五章-21', '第五章', array['A','B','C','D'], array['A','B']),
  ('第五章-22', '第五章', array['A','B','C','D'], array['A','B','C']),
  ('第五章-23', '第五章', null, null),
  ('第五章-24', '第五章', null, null),
  ('第五章-25', '第五章', null, null),
  ('第五章-26', '第五章', null, null),
  ('第五章-27', '第五章', null, null),
  ('第五章-28', '第五章', null, null),
  ('第五章-29', '第五章', null, null),
  ('第五章-30', '第五章', null, null),
  ('第五章-31', '第五章', array['A','B'], array['A']),
  ('第五章-32', '第五章', array['A','B'], array['A']),
  ('第五章-33', '第五章', array['A','B'], array['A']),
  ('第五章-34', '第五章', array['A','B'], array['A']),
  ('第五章-35', '第五章', array['A','B'], array['A']),
  ('第五章-36', '第五章', array['A','B'], array['A']),
  ('第五章-37', '第五章', array['A','B'], array['A']),
  ('第五章-38', '第五章', array['A','B'], array['A']),
  ('第五章-39', '第五章', array['A','B'], array['A']),
  ('第五章-40', '第五章', array['A','B'], array['A']),
  ('第五章-41', '第五章', array['A','B'], array['B']),
  ('第五章-42', '第五章', array['A','B'], array['B']),
  ('第五章-43', '第五章', array['A','B'], array['A']),
  ('第五章-44', '第五章', array['A','B'], array['A']),
  ('第五章-45', '第五章', array['A','B'], array['A']),
  ('第五章-46', '第五章', array['A','B'], array['A']),
  ('第五章-47', '第五章', array['A','B'], array['A']),
  ('第六章-1', '第六章', array['A','B','C','D'], array['B']),
  ('第六章-2', '第六章', array['A','B','C','D'], array['D']),
  ('第六章-3', '第六章', array['A','B','C','D'], array['C']),
  ('第六章-4', '第六章', array['A','B','C','D'], array['A']),
  ('第六章-5', '第六章', array['A','B','C','D'], array['B']),
  ('第六章-6', '第六章', array['A','B','C','D'], array['C']),
  ('第六章-7', '第六章', array['A','B','C','D'], array['B']),
  ('第六章-8', '第六章', array['A','B','C','D'], array['D']),
  ('第六章-9', '第六章', array['A','B','C','D'], array['A']),
  ('第六章-10', '第六章', array['A','B','C','D'], array['A']),
  ('第六章-11', '第六章', array['A','B','C','D'], array['B']),
  ('第六章-12', '第六章', array['A','B','C','D'], array['D']),
  ('第六章-13', '第六章', array['A','B','C','D'], array['D']),
  ('第六章-14', '第六章', array['A','B','C','D'], array['D']),
  ('第六章-15', '第六章', array['A','B','C','D'], array['B']),
  ('第六章-16', '第六章', array['A','B','C','D'], array['D']),
  ('第六章-17', '第六章', array['A','B','C','D'], array['C']),
  ('第六章-18', '第六章', array['A','B','C','D'], array['B']),
  ('第六章-19', '第六章', array['A','B','C','D'], array['C']),
  ('第六章-20', '第六章', array['A','B','C','D'], array['B']),
  ('第六章-21', '第六章', array['A','B','C','D'], array['A']),
  ('第六章-22', '第六章', array['A','B','C','D'], array['B']),
  ('第六章-23', '第六章', array['A','B','C','D'], array['B']),
  ('第六章-24', '第六章', array['A','B','C','D'], array['D']),
  ('第六章-25', '第六章', array['A','B','C','D'], array['C']),
  ('第六章-26', '第六章', array['A','B','C','D'], array['B']),
  ('第六章-27', '第六章', array['A','B','C','D'], array['A']),
  ('第六章-28', '第六章', array['A','B','C','D'], array['D']),
  ('第六章-29', '第六章', array['A','B','C','D'], array['A']),
  ('第六章-30', '第六章', array['A','B','C','D'], array['A']),
  ('第六章-31', '第六章', array['A','B','C','D'], array['A']),
  ('第六章-32', '第六章', array['A','B','C','D'], array['A']),
  ('第六章-33', '第六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第六章-34', '第六章', array['A','B','C','D'], array['A','C','D']),
  ('第六章-35', '第六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第六章-36', '第六章', array['A','B','C','D'], array['A','C','D']),
  ('第六章-37', '第六章', array['A','B','C','D'], array['B','D']),
  ('第六章-38', '第六章', array['A','B','C','D'], array['B','C','D']),
  ('第六章-39', '第六章', array['A','B','C','D'], array['A','B','C']),
  ('第六章-40', '第六章', array['A','B','C','D'], array['A','B','D']),
  ('第六章-41', '第六章', array['A','B','C','D'], array['C','D']),
  ('第六章-42', '第六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第六章-43', '第六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第六章-44', '第六章', array['A','B','C','D'], array['A','B','C']),
  ('第六章-45', '第六章', null, null),
  ('第六章-46', '第六章', null, null),
  ('第六章-47', '第六章', null, null),
  ('第六章-48', '第六章', null, null),
  ('第六章-49', '第六章', null, null),
  ('第六章-50', '第六章', array['A','B'], array['A']),
  ('第六章-51', '第六章', array['A','B'], array['A']),
  ('第六章-52', '第六章', array['A','B'], array['A']),
  ('第六章-53', '第六章', array['A','B'], array['B']),
  ('第六章-54', '第六章', array['A','B'], array['A']),
  ('第六章-55', '第六章', array['A','B'], array['A']),
  ('第六章-56', '第六章', array['A','B'], array['A']),
  ('第六章-57', '第六章', array['A','B'], array['A']),
  ('第六章-58', '第六章', array['A','B'], array['A']),
  ('第六章-59', '第六章', array['A','B'], array['A']),
  ('第六章-60', '第六章', array['A','B'], array['A']),
  ('第六章-61', '第六章', array['A','B'], array['A']),
  ('第六章-62', '第六章', array['A','B'], array['A']),
  ('第六章-63', '第六章', array['A','B'], array['A']),
  ('第六章-64', '第六章', array['A','B'], array['A']),
  ('第六章-65', '第六章', array['A','B'], array['B']),
  ('第六章-66', '第六章', array['A','B'], array['A']),
  ('第六章-67', '第六章', array['A','B'], array['A']),
  ('第六章-68', '第六章', array['A','B'], array['A']),
  ('第七章-1', '第七章', array['A','B','C','D'], array['A']),
  ('第七章-2', '第七章', array['A','B','C','D'], array['B']),
  ('第七章-3', '第七章', array['A','B','C','D'], array['A']),
  ('第七章-4', '第七章', array['A','B','C','D'], array['A']),
  ('第七章-5', '第七章', array['A','B','C','D'], array['B']),
  ('第七章-6', '第七章', array['A','B','C','D'], array['C']),
  ('第七章-7', '第七章', array['A','B','C','D'], array['D']),
  ('第七章-8', '第七章', array['A','B','C','D'], array['A']),
  ('第七章-9', '第七章', array['A','B','C','D'], array['B']),
  ('第七章-10', '第七章', array['A','B','C','D'], array['B','C','D']),
  ('第七章-11', '第七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第七章-12', '第七章', array['A','B','C','D'], array['A','B','C']),
  ('第七章-13', '第七章', array['A','B','C','D'], array['A','B','D']),
  ('第七章-14', '第七章', array['A','B','C','D'], array['B','D']),
  ('第七章-15', '第七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第七章-16', '第七章', array['A','B','C','D'], array['A','B','C']),
  ('第七章-17', '第七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第七章-18', '第七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第七章-19', '第七章', array['A','B','C','D'], array['A','B','C']),
  ('第七章-20', '第七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第七章-21', '第七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第七章-22', '第七章', array['A','B','C','D'], array['B','C','D']),
  ('第七章-23', '第七章', array['A','B','C','D'], array['A','C','D']),
  ('第七章-24', '第七章', array['A','B','C','D'], array['A','B','D']),
  ('第七章-25', '第七章', array['A','B','C','D'], array['A','B','D']),
  ('第七章-26', '第七章', array['A','B','C','D'], array['B','C']),
  ('第七章-27', '第七章', array['A','B','C','D'], array['B','C','D']),
  ('第七章-28', '第七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第七章-29', '第七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第七章-30', '第七章', array['A','B','C','D'], array['A','D']),
  ('第七章-31', '第七章', array['A','B','C','D'], array['A','C']),
  ('第七章-32', '第七章', array['A','B','C','D'], array['A','B','D']),
  ('第七章-33', '第七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第七章-34', '第七章', array['A','B','C','D'], array['A','B','C']),
  ('第七章-35', '第七章', null, null),
  ('第七章-36', '第七章', null, null),
  ('第七章-37', '第七章', null, null),
  ('第七章-38', '第七章', null, null),
  ('第七章-39', '第七章', null, null),
  ('第七章-40', '第七章', array['A','B'], array['A']),
  ('第七章-41', '第七章', array['A','B'], array['A']),
  ('第七章-42', '第七章', array['A','B'], array['A']),
  ('第七章-43', '第七章', array['A','B'], array['B']),
  ('第七章-44', '第七章', array['A','B'], array['A']),
  ('第七章-45', '第七章', array['A','B'], array['A']),
  ('第七章-46', '第七章', array['A','B'], array['A']),
  ('第七章-47', '第七章', array['A','B'], array['B']),
  ('第七章-48', '第七章', array['A','B'], array['B']),
  ('第七章-49', '第七章', array['A','B'], array['B']),
  ('第七章-50', '第七章', array['A','B'], array['A']),
  ('第七章-51', '第七章', array['A','B'], array['A']),
  ('第七章-52', '第七章', array['A','B'], array['B']),
  ('第七章-53', '第七章', array['A','B'], array['B']),
  ('第七章-54', '第七章', array['A','B'], array['B']),
  ('第七章-55', '第七章', array['A','B'], array['B']),
  ('第八章-1', '第八章', array['A','B','C','D'], array['A']),
  ('第八章-2', '第八章', array['A','B','C','D'], array['D']),
  ('第八章-3', '第八章', array['A','B','C','D'], array['C']),
  ('第八章-4', '第八章', array['A','B','C','D'], array['C']),
  ('第八章-5', '第八章', array['A','B','C','D'], array['B']),
  ('第八章-6', '第八章', array['A','B','C','D'], array['C']),
  ('第八章-7', '第八章', array['A','B','C','D'], array['D']),
  ('第八章-8', '第八章', array['A','B','C','D'], array['C']),
  ('第八章-9', '第八章', array['A','B','C','D'], array['B']),
  ('第八章-10', '第八章', array['A','B','C','D'], array['D']),
  ('第八章-11', '第八章', array['A','B','C','D'], array['C']),
  ('第八章-12', '第八章', array['A','B','C','D'], array['B']),
  ('第八章-13', '第八章', array['A','B','C','D'], array['C']),
  ('第八章-14', '第八章', array['A','B','C','D'], array['C']),
  ('第八章-15', '第八章', array['A','B','C','D'], array['C']),
  ('第八章-16', '第八章', array['A','B','C','D'], array['B']),
  ('第八章-17', '第八章', array['A','B','C','D'], array['A']),
  ('第八章-18', '第八章', array['A','B','C','D'], array['A']),
  ('第八章-19', '第八章', array['A','B','C','D'], array['B']),
  ('第八章-20', '第八章', array['A','B','C','D'], array['A']),
  ('第八章-21', '第八章', array['A','B','C','D'], array['B']),
  ('第八章-22', '第八章', array['A','B','C','D'], array['A','B','C','D']),
  ('第八章-23', '第八章', array['A','B','C','D'], array['A','B','C','D']),
  ('第八章-24', '第八章', array['A','B','C','D'], array['B','C','D']),
  ('第八章-25', '第八章', array['A','B','C','D'], array['A','B','C']),
  ('第八章-26', '第八章', array['A','B','C','D'], array['A','B','C','D']),
  ('第八章-27', '第八章', array['A','B','C','D'], array['A','B','C','D']),
  ('第八章-28', '第八章', array['A','B','C','D'], array['B','C','D']),
  ('第八章-29', '第八章', array['A','B','C','D'], array['A','B','C','D']),
  ('第八章-30', '第八章', array['A','B','C','D'], array['A','B','C','D']),
  ('第八章-31', '第八章', array['A','B','C','D'], array['A','C']),
  ('第八章-32', '第八章', array['A','B','C','D'], array['A','D']),
  ('第八章-33', '第八章', array['A','B','C','D'], array['A','B','C','D']),
  ('第八章-34', '第八章', array['A','B'], array['A']),
  ('第八章-35', '第八章', array['A','B'], array['A']),
  ('第八章-36', '第八章', array['A','B'], array['A']),
  ('第八章-37', '第八章', array['A','B'], array['B']),
  ('第八章-38', '第八章', array['A','B'], array['A']),
  ('第八章-39', '第八章', array['A','B'], array['B']),
  ('第八章-40', '第八章', array['A','B'], array['B']),
  ('第八章-41', '第八章', array['A','B'], array['B']),
  ('第八章-42', '第八章', array['A','B'], array['B']),
  ('第八章-43', '第八章', array['A','B'], array['A']),
  ('第八章-44', '第八章', array['A','B'], array['A']),
  ('第八章-45', '第八章', array['A','B'], array['B']),
  ('第八章-46', '第八章', array['A','B'], array['A']),
  ('第八章-47', '第八章', array['A','B'], array['B']),
  ('第八章-48', '第八章', array['A','B'], array['A']),
  ('第八章-49', '第八章', array['A','B'], array['A']),
  ('第八章-50', '第八章', array['A','B'], array['A']),
  ('第八章-51', '第八章', array['A','B'], array['A']),
  ('第八章-52', '第八章', array['A','B'], array['A']),
  ('第八章-53', '第八章', array['A','B'], array['A']),
  ('第八章-54', '第八章', array['A','B'], array['A']),
  ('第八章-55', '第八章', array['A','B'], array['A']),
  ('第八章-56', '第八章', array['A','B'], array['A']),
  ('第九章-1', '第九章', array['A','B','C','D'], array['A']),
  ('第九章-2', '第九章', array['A','B','C','D'], array['A']),
  ('第九章-3', '第九章', array['A','B','C','D'], array['D']),
  ('第九章-4', '第九章', array['A','B','C','D'], array['B']),
  ('第九章-5', '第九章', array['A','B','C','D'], array['A']),
  ('第九章-6', '第九章', array['A','B','C','D'], array['C']),
  ('第九章-7', '第九章', array['A','B','C','D'], array['D']),
  ('第九章-8', '第九章', array['A','B','C','D'], array['B']),
  ('第九章-9', '第九章', array['A','B','C','D'], array['B']),
  ('第九章-10', '第九章', array['A','B','C','D'], array['A']),
  ('第九章-11', '第九章', array['A','B','C','D'], array['D']),
  ('第九章-12', '第九章', array['A','B','C','D'], array['A']),
  ('第九章-13', '第九章', array['A','B','C','D'], array['B']),
  ('第九章-14', '第九章', array['A','B','C','D'], array['B']),
  ('第九章-15', '第九章', array['A','B','C','D'], array['A']),
  ('第九章-16', '第九章', array['A','B','C','D'], array['D']),
  ('第九章-17', '第九章', array['A','B','C','D'], array['D']),
  ('第九章-18', '第九章', array['A','B','C','D'], array['D']),
  ('第九章-19', '第九章', array['A','B','C','D'], array['C']),
  ('第九章-20', '第九章', array['A','B','C','D'], array['D']),
  ('第九章-21', '第九章', array['A','B','C','D'], array['A']),
  ('第九章-22', '第九章', array['A','B','C','D'], array['C']),
  ('第九章-23', '第九章', array['A','B','C','D'], array['B']),
  ('第九章-24', '第九章', array['A','B','C','D'], array['A','B','C','D']),
  ('第九章-25', '第九章', array['A','B','C','D'], array['A','B','C','D']),
  ('第九章-26', '第九章', array['A','B','C','D'], array['A','B','C','D']),
  ('第九章-27', '第九章', array['A','B','C','D'], array['A','C','D']),
  ('第九章-28', '第九章', array['A','B','C','D'], array['A','C','D']),
  ('第九章-29', '第九章', array['A','B','C','D'], array['A','B','C','D']),
  ('第九章-30', '第九章', array['A','B','C','D'], array['A','B','C','D']),
  ('第九章-31', '第九章', array['A','B','C','D'], array['A','B','C','D']),
  ('第九章-32', '第九章', array['A','B','C','D'], array['A','B','C','D']),
  ('第九章-33', '第九章', array['A','B','C','D'], array['A','C','D']),
  ('第九章-34', '第九章', array['A','B','C','D'], array['A','B','C']),
  ('第九章-35', '第九章', array['A','B','C','D'], array['A','B','C','D']),
  ('第九章-36', '第九章', array['A','B','C','D'], array['A','B','C','D']),
  ('第九章-37', '第九章', null, null),
  ('第九章-38', '第九章', null, null),
  ('第九章-39', '第九章', array['A','B'], array['B']),
  ('第九章-40', '第九章', array['A','B'], array['A']),
  ('第九章-41', '第九章', array['A','B'], array['A']),
  ('第九章-42', '第九章', array['A','B'], array['A']),
  ('第九章-43', '第九章', array['A','B'], array['A']),
  ('第九章-44', '第九章', array['A','B'], array['A']),
  ('第九章-45', '第九章', array['A','B'], array['A']),
  ('第九章-46', '第九章', array['A','B'], array['A']),
  ('第九章-47', '第九章', array['A','B'], array['B']),
  ('第九章-48', '第九章', array['A','B'], array['B']),
  ('第九章-49', '第九章', array['A','B'], array['A']),
  ('第九章-50', '第九章', array['A','B'], array['A']),
  ('第九章-51', '第九章', array['A','B'], array['B']),
  ('第九章-52', '第九章', array['A','B'], array['A']),
  ('第九章-53', '第九章', array['A','B'], array['A']),
  ('第九章-54', '第九章', array['A','B'], array['B']),
  ('第十章-1', '第十章', array['A','B','C','D'], array['C']),
  ('第十章-2', '第十章', array['A','B','C','D'], array['A']),
  ('第十章-3', '第十章', array['A','B','C','D'], array['A']),
  ('第十章-4', '第十章', array['A','B','C','D'], array['C']),
  ('第十章-5', '第十章', array['A','B','C','D'], array['A']),
  ('第十章-6', '第十章', array['A','B','C','D'], array['D']),
  ('第十章-7', '第十章', array['A','B','C','D'], array['B']),
  ('第十章-8', '第十章', array['A','B','C','D'], array['B']),
  ('第十章-9', '第十章', array['A','B','C','D'], array['A']),
  ('第十章-10', '第十章', array['A','B','C','D'], array['C']),
  ('第十章-11', '第十章', array['A','B','C','D'], array['A']),
  ('第十章-12', '第十章', array['A','B','C','D'], array['D']),
  ('第十章-13', '第十章', array['A','B','C','D'], array['C']),
  ('第十章-14', '第十章', array['A','B','C','D'], array['C']),
  ('第十章-15', '第十章', array['A','B','C','D'], array['A']),
  ('第十章-16', '第十章', array['A','B','C','D'], array['C']),
  ('第十章-17', '第十章', array['A','B','C','D'], array['D']),
  ('第十章-18', '第十章', array['A','B','C','D'], array['D']),
  ('第十章-19', '第十章', array['A','B','C','D'], array['A']),
  ('第十章-20', '第十章', array['A','B','C','D'], array['C']),
  ('第十章-21', '第十章', array['A','B','C','D'], array['B']),
  ('第十章-22', '第十章', array['A','B','C','D'], array['C']),
  ('第十章-23', '第十章', array['A','B','C','D'], array['B']),
  ('第十章-24', '第十章', array['A','B','C','D'], array['C']),
  ('第十章-25', '第十章', array['A','B','C','D'], array['B']),
  ('第十章-26', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-27', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-28', '第十章', array['A','B','C','D'], array['B','D']),
  ('第十章-29', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-30', '第十章', array['A','B','C','D'], array['B','C','D']),
  ('第十章-31', '第十章', array['A','B','C','D'], array['B','C']),
  ('第十章-32', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-33', '第十章', array['A','B','C','D'], array['B','C','D']),
  ('第十章-34', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-35', '第十章', array['A','B','C','D'], array['A','C','D']),
  ('第十章-36', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-37', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-38', '第十章', array['A','B','C','D'], array['A','C','D']),
  ('第十章-39', '第十章', array['A','B','C','D'], array['A','B','D']),
  ('第十章-40', '第十章', array['A','B','C','D'], array['B','C']),
  ('第十章-41', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-42', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-43', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-44', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-45', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-46', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-47', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-48', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-49', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-50', '第十章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十章-51', '第十章', null, null),
  ('第十章-52', '第十章', null, null),
  ('第十章-53', '第十章', null, null),
  ('第十章-54', '第十章', null, null),
  ('第十章-55', '第十章', null, null),
  ('第十章-56', '第十章', null, null),
  ('第十章-57', '第十章', array['A','B'], array['B']),
  ('第十章-58', '第十章', array['A','B'], array['A']),
  ('第十章-59', '第十章', array['A','B'], array['B']),
  ('第十章-60', '第十章', array['A','B'], array['A']),
  ('第十一章-1', '第十一章', array['A','B','C','D'], array['B']),
  ('第十一章-2', '第十一章', array['A','B','C','D'], array['C']),
  ('第十一章-3', '第十一章', array['A','B','C','D'], array['A']),
  ('第十一章-4', '第十一章', array['A','B','C','D'], array['B']),
  ('第十一章-5', '第十一章', array['A','B','C','D'], array['D']),
  ('第十一章-6', '第十一章', array['A','B','C','D'], array['C']),
  ('第十一章-7', '第十一章', array['A','B','C','D'], array['B']),
  ('第十一章-8', '第十一章', array['A','B','C','D'], array['D']),
  ('第十一章-9', '第十一章', array['A','B','C','D'], array['B']),
  ('第十一章-10', '第十一章', array['A','B','C','D'], array['A']),
  ('第十一章-11', '第十一章', array['A','B','C','D'], array['A']),
  ('第十一章-12', '第十一章', array['A','B','C','D'], array['C']),
  ('第十一章-13', '第十一章', array['A','B','C','D'], array['B']),
  ('第十一章-14', '第十一章', array['A','B','C','D'], array['A']),
  ('第十一章-15', '第十一章', array['A','B','C','D'], array['D']),
  ('第十一章-16', '第十一章', array['A','B','C','D'], array['D']),
  ('第十一章-17', '第十一章', array['A','B','C','D'], array['B']),
  ('第十一章-18', '第十一章', array['A','B','C','D'], array['B']),
  ('第十一章-19', '第十一章', array['A','B','C','D'], array['C']),
  ('第十一章-20', '第十一章', array['A','B','C','D'], array['B']),
  ('第十一章-21', '第十一章', array['A','B','C','D'], array['A']),
  ('第十一章-22', '第十一章', array['A','B','C','D'], array['C']),
  ('第十一章-23', '第十一章', array['A','B','C','D'], array['A']),
  ('第十一章-24', '第十一章', array['A','B','C','D'], array['B']),
  ('第十一章-25', '第十一章', array['A','B','C','D'], array['B']),
  ('第十一章-26', '第十一章', array['A','B','C','D'], array['B']),
  ('第十一章-27', '第十一章', array['A','B','C','D'], array['D']),
  ('第十一章-28', '第十一章', array['A','B','C','D'], array['D']),
  ('第十一章-29', '第十一章', array['A','B','C','D'], array['B']),
  ('第十一章-30', '第十一章', array['A','B','C','D'], array['D']),
  ('第十一章-31', '第十一章', array['A','B','C','D'], array['A']),
  ('第十一章-32', '第十一章', array['A','B','C','D'], array['C']),
  ('第十一章-33', '第十一章', array['A','B','C','D'], array['A']),
  ('第十一章-34', '第十一章', array['A','B','C','D'], array['C']),
  ('第十一章-35', '第十一章', array['A','B','C','D'], array['D']),
  ('第十一章-36', '第十一章', array['A','B','C','D'], array['B']),
  ('第十一章-37', '第十一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十一章-38', '第十一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十一章-39', '第十一章', array['A','B','C','D'], array['A','B','C']),
  ('第十一章-40', '第十一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十一章-41', '第十一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十一章-42', '第十一章', array['A','B','C','D'], array['A','C','D']),
  ('第十一章-43', '第十一章', array['A','B','C','D'], array['B','C','D']),
  ('第十一章-44', '第十一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十一章-45', '第十一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十一章-46', '第十一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十一章-47', '第十一章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十一章-48', '第十一章', array['A','B','C','D'], array['A','B','D']),
  ('第十一章-49', '第十一章', array['A','B','C','D'], array['B','C']),
  ('第十一章-50', '第十一章', array['A','B'], array['B']),
  ('第十一章-51', '第十一章', array['A','B'], array['A']),
  ('第十一章-52', '第十一章', array['A','B'], array['A']),
  ('第十一章-53', '第十一章', array['A','B'], array['A']),
  ('第十一章-54', '第十一章', array['A','B'], array['A']),
  ('第十一章-55', '第十一章', array['A','B'], array['B']),
  ('第十一章-56', '第十一章', array['A','B'], array['B']),
  ('第十一章-57', '第十一章', array['A','B'], array['B']),
  ('第十一章-58', '第十一章', array['A','B'], array['A']),
  ('第十一章-59', '第十一章', array['A','B'], array['A']),
  ('第十一章-60', '第十一章', array['A','B'], array['A']),
  ('第十一章-61', '第十一章', array['A','B'], array['A']),
  ('第十一章-62', '第十一章', array['A','B'], array['A']),
  ('第十一章-63', '第十一章', array['A','B'], array['A']),
  ('第十二章-1', '第十二章', array['A','B','C','D'], array['B']),
  ('第十二章-2', '第十二章', array['A','B','C','D'], array['C']),
  ('第十二章-3', '第十二章', array['A','B','C','D'], array['B']),
  ('第十二章-4', '第十二章', array['A','B','C','D'], array['D']),
  ('第十二章-5', '第十二章', array['A','B','C','D'], array['A']),
  ('第十二章-6', '第十二章', array['A','B','C','D'], array['C']),
  ('第十二章-7', '第十二章', array['A','B','C','D'], array['D']),
  ('第十二章-8', '第十二章', array['A','B','C','D'], array['D']),
  ('第十二章-9', '第十二章', array['A','B','C','D'], array['D']),
  ('第十二章-10', '第十二章', array['A','B','C','D'], array['B']),
  ('第十二章-11', '第十二章', array['A','B','C','D'], array['C']),
  ('第十二章-12', '第十二章', array['A','B','C','D'], array['C']),
  ('第十二章-13', '第十二章', array['A','B','C','D'], array['B']),
  ('第十二章-14', '第十二章', array['A','B','C','D'], array['C']),
  ('第十二章-15', '第十二章', array['A','B','C','D'], array['B','C','D']),
  ('第十二章-16', '第十二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十二章-17', '第十二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十二章-18', '第十二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十二章-19', '第十二章', array['A','B','C','D'], array['A','B','C']),
  ('第十二章-20', '第十二章', array['A','B','C','D'], array['A','C']),
  ('第十二章-21', '第十二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十二章-22', '第十二章', array['A','B','C','D'], array['A','B','C']),
  ('第十二章-23', '第十二章', array['A','B','C','D'], array['A','B']),
  ('第十二章-24', '第十二章', array['A','B','C','D'], array['A','C','D']),
  ('第十二章-25', '第十二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十二章-26', '第十二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十二章-27', '第十二章', array['A','B','C','D'], array['A','B','C']),
  ('第十二章-28', '第十二章', array['A','B','C','D'], array['A','B','D']),
  ('第十二章-29', '第十二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十二章-30', '第十二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十二章-31', '第十二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十二章-32', '第十二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十二章-33', '第十二章', array['A','B','C','D'], array['A','B','C']),
  ('第十二章-34', '第十二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十二章-35', '第十二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十二章-36', '第十二章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十二章-37', '第十二章', null, null),
  ('第十二章-38', '第十二章', array['A','B'], array['A']),
  ('第十二章-39', '第十二章', array['A','B'], array['A']),
  ('第十二章-40', '第十二章', array['A','B'], array['A']),
  ('第十二章-41', '第十二章', array['A','B'], array['A']),
  ('第十二章-42', '第十二章', array['A','B'], array['A']),
  ('第十二章-43', '第十二章', array['A','B'], array['B']),
  ('第十二章-44', '第十二章', array['A','B'], array['A']),
  ('第十二章-45', '第十二章', array['A','B'], array['B']),
  ('第十二章-46', '第十二章', array['A','B'], array['A']),
  ('第十二章-47', '第十二章', array['A','B'], array['A']),
  ('第十二章-48', '第十二章', array['A','B'], array['A']),
  ('第十二章-49', '第十二章', array['A','B'], array['A']),
  ('第十二章-50', '第十二章', array['A','B'], array['A']),
  ('第十二章-51', '第十二章', array['A','B'], array['A']),
  ('第十二章-52', '第十二章', array['A','B'], array['A']),
  ('第十二章-53', '第十二章', array['A','B'], array['A']),
  ('第十二章-54', '第十二章', array['A','B'], array['A']),
  ('第十二章-55', '第十二章', array['A','B'], array['A']),
  ('第十二章-56', '第十二章', array['A','B'], array['A']),
  ('第十二章-57', '第十二章', array['A','B'], array['A']),
  ('第十二章-58', '第十二章', array['A','B'], array['B']),
  ('第十二章-59', '第十二章', array['A','B'], array['A']),
  ('第十二章-60', '第十二章', array['A','B'], array['A']),
  ('第十二章-61', '第十二章', array['A','B'], array['A']),
  ('第十二章-62', '第十二章', array['A','B'], array['A']),
  ('第十二章-63', '第十二章', array['A','B'], array['A']),
  ('第十二章-64', '第十二章', array['A','B'], array['B']),
  ('第十三章-1', '第十三章', array['A','B','C','D'], array['B']),
  ('第十三章-2', '第十三章', array['A','B','C','D'], array['B']),
  ('第十三章-3', '第十三章', array['A','B','C','D'], array['C']),
  ('第十三章-4', '第十三章', array['A','B','C','D'], array['B']),
  ('第十三章-5', '第十三章', array['A','B','C','D'], array['C']),
  ('第十三章-6', '第十三章', array['A','B','C','D'], array['B']),
  ('第十三章-7', '第十三章', array['A','B','C','D'], array['D']),
  ('第十三章-8', '第十三章', array['A','B','C','D'], array['C']),
  ('第十三章-9', '第十三章', array['A','B','C','D'], array['B']),
  ('第十三章-10', '第十三章', array['A','B','C','D'], array['C']),
  ('第十三章-11', '第十三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十三章-12', '第十三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十三章-13', '第十三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十三章-14', '第十三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十三章-15', '第十三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十三章-16', '第十三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十三章-17', '第十三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十三章-18', '第十三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十三章-19', '第十三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十三章-20', '第十三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十三章-21', '第十三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十三章-22', '第十三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十三章-23', '第十三章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十三章-24', '第十三章', null, null),
  ('第十三章-25', '第十三章', array['A','B'], array['A']),
  ('第十三章-26', '第十三章', array['A','B'], array['A']),
  ('第十三章-27', '第十三章', array['A','B'], array['A']),
  ('第十三章-28', '第十三章', array['A','B'], array['A']),
  ('第十三章-29', '第十三章', array['A','B'], array['A']),
  ('第十三章-30', '第十三章', array['A','B'], array['A']),
  ('第十三章-31', '第十三章', array['A','B'], array['A']),
  ('第十三章-32', '第十三章', array['A','B'], array['A']),
  ('第十三章-33', '第十三章', array['A','B'], array['A']),
  ('第十三章-34', '第十三章', array['A','B'], array['A']),
  ('第十三章-35', '第十三章', array['A','B'], array['A']),
  ('第十三章-36', '第十三章', array['A','B'], array['A']),
  ('第十三章-37', '第十三章', array['A','B'], array['A']),
  ('第十三章-38', '第十三章', array['A','B'], array['A']),
  ('第十三章-39', '第十三章', array['A','B'], array['A']),
  ('第十三章-40', '第十三章', array['A','B'], array['A']),
  ('第十三章-41', '第十三章', array['A','B'], array['A']),
  ('第十三章-42', '第十三章', array['A','B'], array['A']),
  ('第十三章-43', '第十三章', array['A','B'], array['A']),
  ('第十三章-44', '第十三章', array['A','B'], array['A']),
  ('第十三章-45', '第十三章', array['A','B'], array['A']),
  ('第十三章-46', '第十三章', array['A','B'], array['A']),
  ('第十三章-47', '第十三章', array['A','B'], array['A']),
  ('第十三章-48', '第十三章', array['A','B'], array['A']),
  ('第十三章-49', '第十三章', array['A','B'], array['A']),
  ('第十三章-50', '第十三章', array['A','B'], array['A']),
  ('第十三章-51', '第十三章', array['A','B'], array['A']),
  ('第十三章-52', '第十三章', array['A','B'], array['A']),
  ('第十三章-53', '第十三章', array['A','B'], array['A']),
  ('第十三章-54', '第十三章', array['A','B'], array['A']),
  ('第十四章-1', '第十四章', array['A','B','C','D'], array['A']),
  ('第十四章-2', '第十四章', array['A','B','C','D'], array['C']),
  ('第十四章-3', '第十四章', array['A','B','C','D'], array['B']),
  ('第十四章-4', '第十四章', array['A','B','C','D'], array['C']),
  ('第十四章-5', '第十四章', array['A','B','C','D'], array['A']),
  ('第十四章-6', '第十四章', array['A','B','C','D'], array['B']),
  ('第十四章-7', '第十四章', array['A','B','C','D'], array['C']),
  ('第十四章-8', '第十四章', array['A','B','C','D'], array['C']),
  ('第十四章-9', '第十四章', array['A','B','C','D'], array['B']),
  ('第十四章-10', '第十四章', array['A','B','C','D'], array['C']),
  ('第十四章-11', '第十四章', array['A','B','C','D'], array['C']),
  ('第十四章-12', '第十四章', array['A','B','C','D'], array['A']),
  ('第十四章-13', '第十四章', array['A','B','C','D'], array['B']),
  ('第十四章-14', '第十四章', array['A','B','C','D'], array['C']),
  ('第十四章-15', '第十四章', array['A','B','C','D'], array['B']),
  ('第十四章-16', '第十四章', array['A','B','C','D'], array['A']),
  ('第十四章-17', '第十四章', array['A','B','C','D'], array['C']),
  ('第十四章-18', '第十四章', array['A','B','C','D'], array['B']),
  ('第十四章-19', '第十四章', array['A','B','C','D'], array['C']),
  ('第十四章-20', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-21', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-22', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-23', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-24', '第十四章', array['A','B','C','D'], array['A','C','D']),
  ('第十四章-25', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-26', '第十四章', array['A','B','C','D'], array['B','C','D']),
  ('第十四章-27', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-28', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-29', '第十四章', array['A','B','C','D'], array['A','B','C']),
  ('第十四章-30', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-31', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-32', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-33', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-34', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-35', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-36', '第十四章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十四章-37', '第十四章', array['A','B'], array['A']),
  ('第十四章-38', '第十四章', array['A','B'], array['A']),
  ('第十四章-39', '第十四章', array['A','B'], array['A']),
  ('第十四章-40', '第十四章', array['A','B'], array['B']),
  ('第十四章-41', '第十四章', array['A','B'], array['A']),
  ('第十四章-42', '第十四章', array['A','B'], array['A']),
  ('第十四章-43', '第十四章', array['A','B'], array['A']),
  ('第十四章-44', '第十四章', array['A','B'], array['A']),
  ('第十四章-45', '第十四章', array['A','B'], array['A']),
  ('第十四章-46', '第十四章', array['A','B'], array['A']),
  ('第十四章-47', '第十四章', array['A','B'], array['A']),
  ('第十四章-48', '第十四章', array['A','B'], array['A']),
  ('第十四章-49', '第十四章', array['A','B'], array['A']),
  ('第十四章-50', '第十四章', array['A','B'], array['A']),
  ('第十四章-51', '第十四章', array['A','B'], array['B']),
  ('第十四章-52', '第十四章', array['A','B'], array['A']),
  ('第十四章-53', '第十四章', array['A','B'], array['A']),
  ('第十四章-54', '第十四章', array['A','B'], array['A']),
  ('第十四章-55', '第十四章', array['A','B'], array['A']),
  ('第十四章-56', '第十四章', array['A','B'], array['A']),
  ('第十四章-57', '第十四章', array['A','B'], array['A']),
  ('第十四章-58', '第十四章', array['A','B'], array['A']),
  ('第十四章-59', '第十四章', array['A','B'], array['A']),
  ('第十四章-60', '第十四章', array['A','B'], array['A']),
  ('第十四章-61', '第十四章', array['A','B'], array['A']),
  ('第十四章-62', '第十四章', array['A','B'], array['B']),
  ('第十四章-63', '第十四章', array['A','B'], array['B']),
  ('第十四章-64', '第十四章', array['A','B'], array['A']),
  ('第十四章-65', '第十四章', array['A','B'], array['A']),
  ('第十四章-66', '第十四章', array['A','B'], array['A']),
  ('第十四章-67', '第十四章', array['A','B'], array['A']),
  ('第十五章-1', '第十五章', array['A','B','C','D'], array['C']),
  ('第十五章-2', '第十五章', array['A','B','C','D'], array['B']),
  ('第十五章-3', '第十五章', array['A','B','C','D'], array['C']),
  ('第十五章-4', '第十五章', array['A','B','C','D'], array['D']),
  ('第十五章-5', '第十五章', array['A','B','C','D'], array['B']),
  ('第十五章-6', '第十五章', array['A','B','C','D'], array['D']),
  ('第十五章-7', '第十五章', array['A','B','C','D'], array['D']),
  ('第十五章-8', '第十五章', array['A','B','C','D'], array['D']),
  ('第十五章-9', '第十五章', array['A','B','C','D'], array['C']),
  ('第十五章-10', '第十五章', array['A','B','C','D'], array['D']),
  ('第十五章-11', '第十五章', array['A','B','C','D'], array['D']),
  ('第十五章-12', '第十五章', array['A','B','C','D'], array['C']),
  ('第十五章-13', '第十五章', array['A','B','C','D'], array['D']),
  ('第十五章-14', '第十五章', array['A','B','C','D'], array['C']),
  ('第十五章-15', '第十五章', array['A','B','C','D'], array['A']),
  ('第十五章-16', '第十五章', array['A','B','C','D'], array['A']),
  ('第十五章-17', '第十五章', array['A','B','C','D'], array['B']),
  ('第十五章-18', '第十五章', array['A','B','C','D'], array['C']),
  ('第十五章-19', '第十五章', array['A','B','C','D'], array['C']),
  ('第十五章-20', '第十五章', array['A','B','C','D'], array['A']),
  ('第十五章-21', '第十五章', array['A','B','C','D'], array['D']),
  ('第十五章-22', '第十五章', array['A','B','C','D'], array['B']),
  ('第十五章-23', '第十五章', array['A','B','C','D'], array['B']),
  ('第十五章-24', '第十五章', array['A','B','C','D'], array['A']),
  ('第十五章-25', '第十五章', array['A','B','C','D'], array['A']),
  ('第十五章-26', '第十五章', array['A','B','C','D'], array['B']),
  ('第十五章-27', '第十五章', array['A','B','C','D'], array['A']),
  ('第十五章-28', '第十五章', array['A','B','C','D'], array['A']),
  ('第十五章-29', '第十五章', array['A','B','C','D'], array['A','B','C']),
  ('第十五章-30', '第十五章', array['A','B','C','D'], array['A','B','C']),
  ('第十五章-31', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-32', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-33', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-34', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-35', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-36', '第十五章', array['A','B','C','D'], array['B','C']),
  ('第十五章-37', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-38', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-39', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-40', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-41', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-42', '第十五章', array['A','B','C','D'], array['A','B','C']),
  ('第十五章-43', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-44', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-45', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-46', '第十五章', array['A','B','C','D'], array['A','B']),
  ('第十五章-47', '第十五章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十五章-48', '第十五章', null, null),
  ('第十五章-49', '第十五章', null, null),
  ('第十五章-50', '第十五章', array['A','B'], array['A']),
  ('第十五章-51', '第十五章', array['A','B'], array['A']),
  ('第十五章-52', '第十五章', array['A','B'], array['B']),
  ('第十五章-53', '第十五章', array['A','B'], array['A']),
  ('第十五章-54', '第十五章', array['A','B'], array['A']),
  ('第十五章-55', '第十五章', array['A','B'], array['A']),
  ('第十五章-56', '第十五章', array['A','B'], array['A']),
  ('第十五章-57', '第十五章', array['A','B'], array['B']),
  ('第十五章-58', '第十五章', array['A','B'], array['A']),
  ('第十五章-59', '第十五章', array['A','B'], array['A']),
  ('第十五章-60', '第十五章', array['A','B'], array['A']),
  ('第十五章-61', '第十五章', array['A','B'], array['A']),
  ('第十五章-62', '第十五章', array['A','B'], array['A']),
  ('第十五章-63', '第十五章', array['A','B'], array['A']),
  ('第十五章-64', '第十五章', array['A','B'], array['A']),
  ('第十五章-65', '第十五章', array['A','B'], array['A']),
  ('第十五章-66', '第十五章', array['A','B'], array['A']),
  ('第十五章-67', '第十五章', array['A','B'], array['A']),
  ('第十六章-1', '第十六章', array['A','B','C','D'], array['A']),
  ('第十六章-2', '第十六章', array['A','B','C','D'], array['A']),
  ('第十六章-3', '第十六章', array['A','B','C','D'], array['A']),
  ('第十六章-4', '第十六章', array['A','B','C','D'], array['A']),
  ('第十六章-5', '第十六章', array['A','B','C','D'], array['C']),
  ('第十六章-6', '第十六章', array['A','B','C','D'], array['D']),
  ('第十六章-7', '第十六章', array['A','B','C','D'], array['A']),
  ('第十六章-8', '第十六章', array['A','B','C','D'], array['C']),
  ('第十六章-9', '第十六章', array['A','B','C','D'], array['C']),
  ('第十六章-10', '第十六章', array['A','B','C','D'], array['D']),
  ('第十六章-11', '第十六章', array['A','B','C','D'], array['D']),
  ('第十六章-12', '第十六章', array['A','B','C','D'], array['D']),
  ('第十六章-13', '第十六章', array['A','B','C','D'], array['A']),
  ('第十六章-14', '第十六章', array['A','B','C','D'], array['D']),
  ('第十六章-15', '第十六章', array['A','B','C','D'], array['B']),
  ('第十六章-16', '第十六章', array['A','B','C','D'], array['C']),
  ('第十六章-17', '第十六章', array['A','B','C','D'], array['B']),
  ('第十六章-18', '第十六章', array['A','B','C','D'], array['C']),
  ('第十六章-19', '第十六章', array['A','B','C','D'], array['B']),
  ('第十六章-20', '第十六章', array['A','B','C','D'], array['D']),
  ('第十六章-21', '第十六章', array['A','B','C','D'], array['A']),
  ('第十六章-22', '第十六章', array['A','B','C','D'], array['C']),
  ('第十六章-23', '第十六章', array['A','B','C','D'], array['B']),
  ('第十六章-24', '第十六章', array['A','B','C','D'], array['D']),
  ('第十六章-25', '第十六章', array['A','B','C','D'], array['D']),
  ('第十六章-26', '第十六章', array['A','B','C','D'], array['D']),
  ('第十六章-27', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-28', '第十六章', array['A','B','C','D'], array['A','C']),
  ('第十六章-29', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-30', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-31', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-32', '第十六章', array['A','B','C','D'], array['A','B','C']),
  ('第十六章-33', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-34', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-35', '第十六章', array['A','B','C','D'], array['A','C']),
  ('第十六章-36', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-37', '第十六章', array['A','B','C','D'], array['A','B','C']),
  ('第十六章-38', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-39', '第十六章', array['A','B','C','D'], array['A','B','C']),
  ('第十六章-40', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-41', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-42', '第十六章', array['A','B','C','D'], array['A','B','C']),
  ('第十六章-43', '第十六章', array['A','B','C','D'], array['A','B','C']),
  ('第十六章-44', '第十六章', array['A','B','C','D'], array['A','B','C']),
  ('第十六章-45', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-46', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-47', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-48', '第十六章', array['A','B','C','D'], array['A','B','D']),
  ('第十六章-49', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-50', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-51', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-52', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-53', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-54', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-55', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-56', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-57', '第十六章', array['A','B','C','D'], array['A','B','C']),
  ('第十六章-58', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-59', '第十六章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十六章-60', '第十六章', null, null),
  ('第十六章-61', '第十六章', null, null),
  ('第十六章-62', '第十六章', array['A','B'], array['A']),
  ('第十六章-63', '第十六章', array['A','B'], array['A']),
  ('第十六章-64', '第十六章', array['A','B'], array['A']),
  ('第十六章-65', '第十六章', array['A','B'], array['A']),
  ('第十六章-66', '第十六章', array['A','B'], array['A']),
  ('第十六章-67', '第十六章', array['A','B'], array['A']),
  ('第十六章-68', '第十六章', array['A','B'], array['A']),
  ('第十六章-69', '第十六章', array['A','B'], array['B']),
  ('第十六章-70', '第十六章', array['A','B'], array['B']),
  ('第十七章-1', '第十七章', array['A','B','C','D'], array['B']),
  ('第十七章-2', '第十七章', array['A','B','C','D'], array['D']),
  ('第十七章-3', '第十七章', array['A','B','C','D'], array['A']),
  ('第十七章-4', '第十七章', array['A','B','C','D'], array['A']),
  ('第十七章-5', '第十七章', array['A','B','C','D'], array['D']),
  ('第十七章-6', '第十七章', array['A','B','C','D'], array['D']),
  ('第十七章-7', '第十七章', array['A','B','C','D'], array['D']),
  ('第十七章-8', '第十七章', array['A','B','C','D'], array['A']),
  ('第十七章-9', '第十七章', array['A','B','C','D'], array['A']),
  ('第十七章-10', '第十七章', array['A','B','C','D'], array['A']),
  ('第十七章-11', '第十七章', array['A','B','C','D'], array['C']),
  ('第十七章-12', '第十七章', array['A','B','C','D'], array['C']),
  ('第十七章-13', '第十七章', array['A','B','C','D'], array['A']),
  ('第十七章-14', '第十七章', array['A','B','C','D'], array['D']),
  ('第十七章-15', '第十七章', array['A','B','C','D'], array['A']),
  ('第十七章-16', '第十七章', array['A','B','C','D'], array['D']),
  ('第十七章-17', '第十七章', array['A','B','C','D'], array['B']),
  ('第十七章-18', '第十七章', array['A','B','C','D'], array['D']),
  ('第十七章-19', '第十七章', array['A','B','C','D'], array['A']),
  ('第十七章-20', '第十七章', array['A','B','C','D'], array['C']),
  ('第十七章-21', '第十七章', array['A','B','C','D'], array['B']),
  ('第十七章-22', '第十七章', array['A','B','C','D'], array['C']),
  ('第十七章-23', '第十七章', array['A','B','C','D'], array['C']),
  ('第十七章-24', '第十七章', array['A','B','C','D'], array['B']),
  ('第十七章-25', '第十七章', array['A','B','C','D'], array['C']),
  ('第十七章-26', '第十七章', array['A','B','C','D'], array['B']),
  ('第十七章-27', '第十七章', array['A','B','C','D'], array['A']),
  ('第十七章-28', '第十七章', array['A','B','C','D'], array['B']),
  ('第十七章-29', '第十七章', array['A','B','C','D'], array['A']),
  ('第十七章-30', '第十七章', array['A','B','C','D'], array['B']),
  ('第十七章-31', '第十七章', array['A','B','C','D'], array['C']),
  ('第十七章-32', '第十七章', array['A','B','C','D'], array['C']),
  ('第十七章-33', '第十七章', array['A','B','C','D'], array['B']),
  ('第十七章-34', '第十七章', array['A','B','C','D'], array['B']),
  ('第十七章-35', '第十七章', array['A','B','C','D'], array['D']),
  ('第十七章-36', '第十七章', array['A','B','C','D'], array['C']),
  ('第十七章-37', '第十七章', array['A','B','C','D'], array['D']),
  ('第十七章-38', '第十七章', array['A','B','C','D'], array['C']),
  ('第十七章-39', '第十七章', array['A','B','C','D'], array['B']),
  ('第十七章-40', '第十七章', array['A','B','C','D'], array['B']),
  ('第十七章-41', '第十七章', array['A','B','C','D'], array['D']),
  ('第十七章-42', '第十七章', array['A','B','C','D'], array['B']),
  ('第十七章-43', '第十七章', array['A','B','C','D'], array['D']),
  ('第十七章-44', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-45', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-46', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-47', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-48', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-49', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-50', '第十七章', array['A','B','C','D'], array['A','B','C']),
  ('第十七章-51', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-52', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-53', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-54', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-55', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-56', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-57', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-58', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-59', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-60', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-61', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-62', '第十七章', array['A','B','C','D'], array['A','B','D']),
  ('第十七章-63', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-64', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-65', '第十七章', array['A','B','C','D'], array['A','B','C','D']),
  ('第十七章-66', '第十七章', null, null),
  ('第十七章-67', '第十七章', array['A','B'], array['A']),
  ('第十七章-68', '第十七章', array['A','B'], array['A']),
  ('第十七章-69', '第十七章', array['A','B'], array['A']),
  ('第十七章-70', '第十七章', array['A','B'], array['B']),
  ('第十七章-71', '第十七章', array['A','B'], array['A']),
  ('第十七章-72', '第十七章', array['A','B'], array['A']),
  ('第十七章-73', '第十七章', array['A','B'], array['A']),
  ('第十七章-74', '第十七章', array['A','B'], array['A']),
  ('第十七章-75', '第十七章', array['A','B'], array['A']),
  ('第十七章-76', '第十七章', array['A','B'], array['A']),
  ('第十七章-77', '第十七章', array['A','B'], array['A']),
  ('第十七章-78', '第十七章', array['A','B'], array['B']),
  ('第十七章-79', '第十七章', array['A','B'], array['B']),
  ('第十七章-80', '第十七章', array['A','B'], array['A']),
  ('第十七章-81', '第十七章', array['A','B'], array['A']),
  ('结语-1', '结语', array['A','B','C','D'], array['A','B','C','D']),
  ('结语-2', '结语', null, null),
  ('结语-3', '结语', array['A','B'], array['A']),
  ('结语-4', '结语', array['A','B'], array['A']);
