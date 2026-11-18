alter table quiz_pk_private.arenas
  drop constraint arenas_question_ids_check,
  add check (cardinality(question_ids) between 1 and 30),
  add column max_shield integer not null default 100 check (max_shield between 75 and 300);

alter table quiz_pk_private.arena_players
  add column energy integer not null default 0 check (energy between 0 and 15),
  add column barrier integer not null default 0 check (barrier between 0 and 18),
  add column armed text[] not null default '{}',
  add column used text[] not null default '{}';

alter table quiz_pk_private.arena_events
  drop constraint arena_events_kind_check,
  add check (kind in ('hit','miss','message','ready','finish','cast','unlock')),
  add column shield_before integer,
  add column shield_after integer,
  add column blocked integer,
  add column skill text,
  add column charged boolean,
  add column streak integer,
  add column preserved boolean;

create table quiz_pk_private.arena_card_book (
  account_id uuid not null references public.quiz_members(account_id) on delete cascade,
  skill text not null check (skill in ('guard','pierce','repair','focus','combo')),
  unlocked_at timestamptz not null default clock_timestamp(),
  primary key (account_id, skill)
);
alter table quiz_pk_private.arena_card_book enable row level security;
revoke all on quiz_pk_private.arena_card_book from public, anon, authenticated;

create function quiz_pk_private.arena_unlock(game_id uuid, actor uuid, card text)
returns void language plpgsql set search_path = '' as $$
begin
  insert into quiz_pk_private.arena_card_book (account_id, skill) values (actor, card) on conflict do nothing;
  if found then
    insert into quiz_pk_private.arena_events (match_id, account_id, kind, skill)
      values (game_id, actor, 'unlock', card);
  end if;
end
$$;
revoke all on function quiz_pk_private.arena_unlock(uuid, uuid, text) from public, anon, authenticated;

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
      'missedIds', (mine).missed_ids) end,
    'opponentSubmitted', (theirs).account_id is not null,
    'opponent', case when (mine).account_id is not null and (theirs).account_id is not null then jsonb_build_object(
      'correct', (theirs).correct, 'submittedAt', (theirs).submitted_at, 'total', total) end,
    'result', case when (mine).account_id is not null and (theirs).account_id is not null then
      case when (mine).correct > (theirs).correct then 'win'
        when (mine).correct < (theirs).correct then 'loss' else 'tie' end end,
    'retired', (mine).account_id is null or (theirs).account_id is null,
    'status', case when (mine).account_id is not null and (theirs).account_id is not null
      then 'complete' else 'expired' end
  ) from results
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
    'invite', active_invite, 'history', past_games,
    'duel', case when latest_game.id is not null then quiz_pk_private.duel_summary(latest_game, actor) end
  );
end;
$$;

-- Keep older app endpoints callable without allowing another asynchronous round.
-- Existing replies and scores remain archived.
create or replace function quiz_pk_private.start_duel(requested_chapter text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform quiz_pk_private.require_member();
  raise exception 'pk_async_retired' using errcode = '22023';
end
$$;

create or replace function quiz_pk_private.submit_duel(target_duel uuid, answers jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  active_pair uuid := quiz_pk_private.current_arena_pair(actor);
begin
  -- A committed submission may be retried by an older client.
  if exists (select 1 from quiz_pk_private.scores s
    join quiz_pk_private.duels d on d.id = s.duel_id
    where d.id = target_duel and d.pair_id = active_pair and s.account_id = actor) then
    return quiz_pk_private.dashboard();
  end if;
  raise exception 'pk_async_retired' using errcode = '22023';
end
$$;

create or replace function quiz_pk_private.arena_player_summary(p quiz_pk_private.arena_players, finished boolean)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'answered', cardinality(p.missed_ids) + p.correct,
    'correct', p.correct, 'combo', p.combo, 'bestCombo', p.best_combo,
    'shield', p.shield, 'damage', p.damage, 'readyAt', p.ready_at,
    'accuracy', coalesce(round(100.0 * p.correct / nullif(cardinality(p.missed_ids) + p.correct, 0)), 0),
    'energy', p.energy, 'barrier', p.barrier, 'armed', p.armed, 'used', p.used,
    'timeMs', p.time_ms, 'done', p.done or finished, 'forfeited', p.forfeited
  )
$$;

create or replace function quiz_pk_private.arena_summary(game quiz_pk_private.arenas, actor uuid, at_time timestamptz)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  phase text := quiz_pk_private.arena_phase(game, at_time);
  own quiz_pk_private.arena_players;
  opponent quiz_pk_private.arena_players;
  winner text;
  paper jsonb;
  events jsonb;
begin
  select p.* into strict own from quiz_pk_private.arena_players p where p.match_id = game.id and p.account_id = actor;
  select p.* into strict opponent from quiz_pk_private.arena_players p where p.match_id = game.id and p.account_id <> actor;
  if phase = 'finished' then
    winner := case when own.forfeited then 'loss' when opponent.forfeited then 'win'
      when (own.shield, own.correct, -own.time_ms) > (opponent.shield, opponent.correct, -opponent.time_ms) then 'win'
      when (own.shield, own.correct, -own.time_ms) < (opponent.shield, opponent.correct, -opponent.time_ms) then 'loss'
      else 'tie' end;
  end if;
  if own.done or phase = 'finished' then
    paper := jsonb_build_object('picks', own.picks, 'missedIds', own.missed_ids,
      'unansweredIds', array(select q from unnest(game.question_ids) q where not (own.picks ? q)));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'seq', e.seq, 'byMe', e.account_id = actor, 'kind', e.kind, 'damage', e.damage,
    'combo', e.combo, 'critical', e.critical, 'reaction', e.reaction, 'at', e.sent_at,
    'shieldBefore', e.shield_before, 'shieldAfter', e.shield_after, 'blocked', e.blocked,
    'skill', e.skill, 'charged', e.charged, 'streak', e.streak, 'preserved', e.preserved
  ) order by e.seq), '[]'::jsonb) into events from (
    select * from quiz_pk_private.arena_events where match_id = game.id and (kind <> 'unlock' or account_id = actor)
    order by seq desc limit 96
  ) e;
  return jsonb_build_object(
    'id', game.id, 'pairId', game.pair_id, 'chapter', game.chapter, 'phase', phase,
    'isHost', game.host_id = actor, 'startedAt', game.starts_at, 'expiresAt', game.expires_at,
    'serverAt', at_time, 'total', cardinality(game.question_ids), 'maxShield', game.max_shield,
    'questionIds', case when phase in ('active', 'finished') then to_jsonb(game.question_ids) else '[]'::jsonb end,
    'own', quiz_pk_private.arena_player_summary(own, phase = 'finished'),
    'opponent', quiz_pk_private.arena_player_summary(opponent, phase = 'finished'),
    'paper', paper, 'winner', winner, 'events', events
  );
end
$$;

create or replace function quiz_pk_private.arena_state()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  pair uuid := quiz_pk_private.current_arena_pair(actor);
  at_time timestamptz := statement_timestamp();
  latest quiz_pk_private.arenas;
  history jsonb := '[]'::jsonb;
  book jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('skill', c.skill, 'unlockedAt', c.unlocked_at)
    order by c.unlocked_at), '[]'::jsonb) into book
    from quiz_pk_private.arena_card_book c where c.account_id = actor;
  if pair is null then return jsonb_build_object('match', null, 'history', history, 'collection', book); end if;
  select a.* into latest from quiz_pk_private.arenas a where a.pair_id = pair order by a.created_at desc limit 1;
  if latest.id is null then return jsonb_build_object('match', null, 'history', history, 'collection', book, 'pairId', pair); end if;
  select coalesce(jsonb_agg((quiz_pk_private.arena_summary(past.game, actor, at_time) - 'events')
    order by (past.game).created_at desc), '[]'::jsonb) into history from (
    select a as game from quiz_pk_private.arenas a
      where a.pair_id = pair and a.id <> latest.id and quiz_pk_private.arena_phase(a, at_time) = 'finished'
      order by a.created_at desc limit 5
  ) past;
  return jsonb_build_object('match', quiz_pk_private.arena_summary(latest, actor, at_time),
    'history', history, 'collection', book, 'pairId', pair);
end
$$;

create or replace function quiz_pk_private.arena_create(p_chapter text, p_total integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  pair uuid := quiz_pk_private.current_arena_pair(actor);
  at_time timestamptz;
  game quiz_pk_private.arenas;
  partner uuid;
  ids text[];
  capacity integer;
begin
  if p_total is null or p_total < 3 or p_total > 30 then
    raise exception 'arena_invalid_total' using errcode = '22023';
  end if;
  capacity := greatest(75, p_total * 10);
  if pair is null then raise exception 'arena_partner_required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(pair::text, 704));
  select case when p.first_account = actor then p.second_account else p.first_account end into partner
    from quiz_pk_private.pairs p where p.id = pair and p.closed_at is null for update;
  if partner is null then raise exception 'arena_partner_required' using errcode = '42501'; end if;
  at_time := clock_timestamp();
  select a.* into game from quiz_pk_private.arenas a where a.pair_id = pair order by a.created_at desc limit 1;
  if game.id is not null and quiz_pk_private.arena_phase(game, at_time) in ('waiting','countdown','active') then
    return quiz_pk_private.arena_state();
  end if;
  select array(select q.question_id from quiz_pk_private.questions q
    where q.options is not null and (p_chapter is null or q.chapter = p_chapter)
    order by random() limit p_total) into ids;
  if cardinality(ids) = 0 then raise exception 'arena_chapter_empty' using errcode = '22023'; end if;
  if cardinality(ids) <> p_total then raise exception 'arena_not_enough_questions' using errcode = '22023'; end if;
  insert into quiz_pk_private.arenas (pair_id, host_id, chapter, question_ids, created_at, expires_at, max_shield)
    values (pair, actor, p_chapter, ids, at_time, at_time + interval '3 minutes', capacity) returning * into game;
  insert into quiz_pk_private.arena_players (match_id, account_id, ready_at, shield)
    values (game.id, actor, at_time, capacity), (game.id, partner, null, capacity);
  delete from quiz_pk_private.arena_voice_signals where created_at < at_time - interval '2 minutes';
  perform quiz_pk_private.arena_tick(pair);
  return quiz_pk_private.arena_state();
end
$$;

create or replace function quiz_pk_private.arena_join(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  game quiz_pk_private.arenas := quiz_pk_private.arena_lock(p_match_id, actor);
  at_time timestamptz := clock_timestamp();
begin
  if quiz_pk_private.arena_phase(game, at_time) = 'waiting' and game.host_id <> actor then
    update quiz_pk_private.arena_players set ready_at = at_time where match_id = game.id and account_id = actor;
    update quiz_pk_private.arenas set starts_at = at_time + interval '3 seconds',
      expires_at = at_time + make_interval(secs => 23 + 7 * cardinality(game.question_ids)) where id = game.id;
    insert into quiz_pk_private.arena_events (match_id, account_id, kind) values (game.id, actor, 'ready');
    perform quiz_pk_private.arena_tick(game.pair_id);
  end if;
  return quiz_pk_private.arena_state();
end
$$;

create or replace function quiz_pk_private.arena_answer(p_match_id uuid, p_question_id text, p_choice text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  game quiz_pk_private.arenas := quiz_pk_private.arena_lock(p_match_id, actor);
  at_time timestamptz := clock_timestamp();
  own quiz_pk_private.arena_players;
  question quiz_pk_private.questions;
  defender quiz_pk_private.arena_players;
  elapsed integer;
  is_right boolean;
  is_critical boolean;
  damage_dealt integer := 0;
  blocked_damage integer := 0;
  shield_before integer;
  shield_after integer;
  milestone integer;
  popped_skill text;
  energy_gained boolean := false;
  saved_combo boolean := false;
begin
  select p.* into strict own from quiz_pk_private.arena_players p where p.match_id = game.id and p.account_id = actor;
  if own.picks ? p_question_id then return quiz_pk_private.arena_state(); end if;
  if quiz_pk_private.arena_phase(game, at_time) <> 'active' or own.done then return quiz_pk_private.arena_state(); end if;
  if p_question_id is distinct from game.question_ids[own.correct + cardinality(own.missed_ids) + 1] then
    raise exception 'arena_unexpected_question' using errcode = '22023';
  end if;
  select q.* into strict question from quiz_pk_private.questions q where q.question_id = p_question_id;
  if p_choice is null or cardinality(p_choice) > cardinality(question.options)
    or not (p_choice <@ question.options)
    or cardinality(p_choice) <> (select count(distinct pick) from unnest(p_choice) pick) then
    raise exception 'arena_invalid_choice' using errcode = '22023';
  end if;
  is_right := p_choice @> question.correct_options and p_choice <@ question.correct_options;
  elapsed := greatest(0, floor(1000 * extract(epoch from at_time - coalesce(own.last_answer_at, game.starts_at))))::integer;
  if is_right then
    own.combo := own.combo + 1;
    own.correct := own.correct + 1;
    milestone := case when own.combo >= 3 and own.combo % 2 = 1 then own.combo end;
    is_critical := elapsed <= 3500 or milestone is not null;
    energy_gained := own.correct % 2 = 0;
    damage_dealt := 8 + greatest(0, 5 - (elapsed / 1000)) + least(6, (own.combo - 1) * 2)
      + case when milestone is not null then least(8, 3 + milestone) else 0 end;
    select p.* into strict defender from quiz_pk_private.arena_players p
      where p.match_id = game.id and p.account_id <> actor;
    shield_before := defender.shield;
    if 'pierce' = any(own.armed) then
      damage_dealt := damage_dealt + 9;
      popped_skill := 'pierce';
      own.armed := array_remove(own.armed, 'pierce');
    elsif defender.shield > 0 then
      blocked_damage := least(defender.barrier, damage_dealt);
    end if;
    shield_after := greatest(0, shield_before - (damage_dealt - blocked_damage));
    update quiz_pk_private.arena_players p
      set shield = shield_after, barrier = case when shield_after = 0 then 0 else p.barrier - blocked_damage end
      where p.match_id = game.id and p.account_id = defender.account_id;
  else
    is_critical := false;
    if 'focus' = any(own.armed) and own.combo > 0 then
      saved_combo := true;
      popped_skill := 'focus';
      own.armed := array_remove(own.armed, 'focus');
    else
      own.combo := 0;
    end if;
    own.missed_ids := array_append(own.missed_ids, p_question_id);
  end if;
  own.done := own.correct + cardinality(own.missed_ids) = cardinality(game.question_ids);
  update quiz_pk_private.arena_players p set
    picks = p.picks || jsonb_build_object(p_question_id, p_choice), missed_ids = own.missed_ids,
    correct = own.correct, combo = own.combo, best_combo = greatest(own.combo, p.best_combo),
    damage = p.damage + coalesce(shield_before - shield_after, 0), time_ms = p.time_ms + elapsed,
    energy = p.energy + energy_gained::integer, armed = own.armed,
    last_answer_at = at_time, done = own.done
    where p.match_id = game.id and p.account_id = actor;
  insert into quiz_pk_private.arena_events
    (match_id, account_id, kind, damage, combo, critical, shield_before, shield_after, blocked, skill, charged, streak, preserved)
    values (game.id, actor, case when is_right then 'hit' else 'miss' end, coalesce(shield_before - shield_after, 0),
      own.combo, is_critical, shield_before, shield_after, blocked_damage, popped_skill, energy_gained, milestone, saved_combo);
  if popped_skill is not null then perform quiz_pk_private.arena_unlock(game.id, actor, popped_skill); end if;
  if blocked_damage > 0 then perform quiz_pk_private.arena_unlock(game.id, defender.account_id, 'guard'); end if;
  if milestone = 3 then perform quiz_pk_private.arena_unlock(game.id, actor, 'combo'); end if;
  if own.done then
    insert into quiz_pk_private.arena_events (match_id, account_id, kind)
      values (game.id, actor, 'finish');
  end if;
  if quiz_pk_private.arena_phase(game, at_time) = 'finished' then
    delete from quiz_pk_private.arena_voice_signals where match_id = game.id;
  end if;
  perform quiz_pk_private.arena_tick(game.pair_id);
  return quiz_pk_private.arena_state();
end
$$;

create or replace function quiz_pk_private.arena_create(p_chapter text default null)
returns jsonb language sql security definer set search_path = '' as $$
  select quiz_pk_private.arena_create(p_chapter, 10)
$$;

create function quiz_pk_private.arena_cast(p_match_id uuid, p_skill text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  game quiz_pk_private.arenas := quiz_pk_private.arena_lock(p_match_id, actor);
  own quiz_pk_private.arena_players;
  shield_before integer;
begin
  if p_skill is null or p_skill not in ('guard', 'pierce', 'repair', 'focus') then
    raise exception 'arena_invalid_skill' using errcode = '22023';
  end if;
  select p.* into strict own from quiz_pk_private.arena_players p where p.match_id = game.id and p.account_id = actor;
  if p_skill = any(own.used) then return quiz_pk_private.arena_state(); end if;
  if quiz_pk_private.arena_phase(game, clock_timestamp()) <> 'active' or own.done then
    raise exception 'arena_skill_unavailable' using errcode = '22023';
  end if;
  if own.energy < 1 then raise exception 'arena_skill_energy' using errcode = '22023'; end if;

  shield_before := own.shield;
  case p_skill
    when 'guard' then
      if own.shield <= 0 then raise exception 'arena_skill_unavailable' using errcode = '22023'; end if;
      own.barrier := 18;
    when 'repair' then
      if own.shield <= 0 or own.shield >= game.max_shield then
        raise exception 'arena_skill_unavailable' using errcode = '22023';
      end if;
      own.shield := least(game.max_shield, own.shield + 12);
    when 'focus' then
      if own.combo <= 0 then raise exception 'arena_skill_unavailable' using errcode = '22023'; end if;
      own.armed := array_append(own.armed, p_skill);
    when 'pierce' then
      own.armed := array_append(own.armed, p_skill);
  end case;

  update quiz_pk_private.arena_players p set
    energy = p.energy - 1, barrier = own.barrier, armed = own.armed,
    shield = own.shield, used = array_append(p.used, p_skill)
    where p.match_id = game.id and p.account_id = actor;
  insert into quiz_pk_private.arena_events (match_id, account_id, kind, skill, shield_before, shield_after)
    values (game.id, actor, 'cast', p_skill, shield_before, own.shield);
  if p_skill = 'repair' then perform quiz_pk_private.arena_unlock(game.id, actor, p_skill); end if;
  perform quiz_pk_private.arena_tick(game.pair_id);
  return quiz_pk_private.arena_state();
end
$$;

create function public.quiz_arena_create(p_chapter text, p_total integer)
returns jsonb language sql security invoker set search_path = '' as $$
  select quiz_pk_private.arena_create(p_chapter, p_total)
$$;

create function public.quiz_arena_cast(p_match_id uuid, p_skill text)
returns jsonb language sql security invoker set search_path = '' as $$
  select quiz_pk_private.arena_cast(p_match_id, p_skill)
$$;

revoke all on function quiz_pk_private.arena_cast(uuid,text), quiz_pk_private.arena_create(text,integer),
  public.quiz_arena_cast(uuid,text), public.quiz_arena_create(text,integer) from public, anon, authenticated;
grant execute on function quiz_pk_private.arena_cast(uuid,text), quiz_pk_private.arena_create(text,integer),
  public.quiz_arena_cast(uuid,text), public.quiz_arena_create(text,integer) to authenticated;
