-- Private match state and grading. Only a pair's revision counter is published.
create table quiz_pk_private.arenas (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references quiz_pk_private.pairs on delete cascade,
  host_id uuid not null references public.quiz_members(account_id) on delete cascade,
  chapter text,
  question_ids text[] not null check (cardinality(question_ids) between 1 and 10),
  created_at timestamptz not null,
  starts_at timestamptz,
  expires_at timestamptz not null,
  cancelled_at timestamptz
);
create index quiz_arenas_latest on quiz_pk_private.arenas (pair_id, created_at desc);

create table quiz_pk_private.arena_players (
  match_id uuid not null references quiz_pk_private.arenas on delete cascade,
  account_id uuid not null references public.quiz_members(account_id) on delete cascade,
  ready_at timestamptz,
  last_answer_at timestamptz,
  picks jsonb not null default '{}'::jsonb,
  missed_ids text[] not null default '{}',
  correct integer not null default 0,
  combo integer not null default 0,
  best_combo integer not null default 0,
  damage integer not null default 0,
  shield integer not null default 100,
  time_ms integer not null default 0,
  done boolean not null default false,
  forfeited boolean not null default false,
  primary key (match_id, account_id)
);

create table quiz_pk_private.arena_events (
  seq bigint generated always as identity primary key,
  match_id uuid not null references quiz_pk_private.arenas on delete cascade,
  account_id uuid not null references public.quiz_members(account_id) on delete cascade,
  kind text not null check (kind in ('hit','miss','message','ready','finish')),
  damage integer,
  combo integer,
  critical boolean,
  reaction text,
  sent_at timestamptz not null default clock_timestamp()
);
create index quiz_arena_event_feed on quiz_pk_private.arena_events (match_id, seq desc);

create table quiz_pk_private.arena_voice_sessions (
  match_id uuid not null,
  account_id uuid not null,
  session_id uuid not null,
  heartbeat_at timestamptz not null,
  closed boolean not null default false,
  primary key (match_id, account_id),
  foreign key (match_id, account_id) references quiz_pk_private.arena_players on delete cascade
);

create table quiz_pk_private.arena_voice_signals (
  seq bigint generated always as identity primary key,
  match_id uuid not null references quiz_pk_private.arenas on delete cascade,
  session_id uuid not null,
  peer_session_id uuid not null,
  kind text not null check (kind in ('offer','answer','ice')),
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index quiz_arena_voice_mailbox on quiz_pk_private.arena_voice_signals (match_id, peer_session_id, seq);
create index quiz_arena_voice_signal_age on quiz_pk_private.arena_voice_signals (created_at);

alter table quiz_pk_private.arenas enable row level security;
alter table quiz_pk_private.arena_players enable row level security;
alter table quiz_pk_private.arena_events enable row level security;
alter table quiz_pk_private.arena_voice_sessions enable row level security;
alter table quiz_pk_private.arena_voice_signals enable row level security;

create table public.quiz_arena_ticks (
  pair_id uuid primary key references quiz_pk_private.pairs on delete cascade,
  revision bigint not null default 1
);
alter table public.quiz_arena_ticks enable row level security;
revoke all on public.quiz_arena_ticks from public, anon, authenticated;
grant select on public.quiz_arena_ticks to authenticated;

create function quiz_pk_private.current_arena_pair(actor uuid)
returns uuid language sql stable set search_path = '' as $$
  select active.pair_id from quiz_pk_private.active_pair_members as active
  where active.account_id = actor
$$;

create function quiz_pk_private.arena_can_watch(candidate uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select candidate = quiz_pk_private.current_arena_pair(auth.uid())
$$;
create function public.quiz_arena_can_watch(candidate uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select quiz_pk_private.arena_can_watch(candidate)
$$;
revoke all on function public.quiz_arena_can_watch(uuid) from public, anon, authenticated;
grant execute on function public.quiz_arena_can_watch(uuid) to authenticated;
create policy quiz_watch_own_arena on public.quiz_arena_ticks
  for select to authenticated using (public.quiz_arena_can_watch(pair_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.quiz_arena_ticks;
  end if;
end
$$;

create function quiz_pk_private.arena_tick(pair uuid)
returns void language sql set search_path = '' as $$
  insert into public.quiz_arena_ticks as tick (pair_id) values (pair)
  on conflict (pair_id) do update set revision = tick.revision + 1
$$;

create function quiz_pk_private.arena_phase(game quiz_pk_private.arenas, at_time timestamptz)
returns text language sql stable set search_path = '' as $$
  select case
    when game.cancelled_at is not null then 'cancelled'
    when game.starts_at is null then case when at_time >= game.expires_at then 'cancelled' else 'waiting' end
    when at_time >= game.expires_at or exists (
      select 1 from quiz_pk_private.arena_players p where p.match_id = game.id and p.forfeited
    ) or not exists (
      select 1 from quiz_pk_private.arena_players p where p.match_id = game.id and not p.done
    ) then 'finished'
    when at_time < game.starts_at then 'countdown' else 'active' end
$$;

create function quiz_pk_private.arena_player_summary(p quiz_pk_private.arena_players, finished boolean)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'answered', cardinality(p.missed_ids) + p.correct,
    'correct', p.correct, 'combo', p.combo, 'bestCombo', p.best_combo,
    'shield', p.shield, 'damage', p.damage, 'readyAt', p.ready_at,
    'accuracy', coalesce(round(100.0 * p.correct / nullif(cardinality(p.missed_ids) + p.correct, 0)), 0),
    'timeMs', p.time_ms, 'done', p.done or finished, 'forfeited', p.forfeited
  )
$$;

create function quiz_pk_private.arena_summary(game quiz_pk_private.arenas, actor uuid, at_time timestamptz)
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
    'combo', e.combo, 'critical', e.critical, 'reaction', e.reaction, 'at', e.sent_at
  ) order by e.seq), '[]'::jsonb) into events from (
    select * from quiz_pk_private.arena_events where match_id = game.id order by seq desc limit 32
  ) e;
  return jsonb_build_object(
    'id', game.id, 'pairId', game.pair_id, 'chapter', game.chapter, 'phase', phase,
    'isHost', game.host_id = actor, 'startedAt', game.starts_at, 'expiresAt', game.expires_at,
    'serverAt', at_time, 'total', cardinality(game.question_ids),
    'questionIds', case when phase in ('active', 'finished') then to_jsonb(game.question_ids) else '[]'::jsonb end,
    'own', quiz_pk_private.arena_player_summary(own, phase = 'finished'),
    'opponent', quiz_pk_private.arena_player_summary(opponent, phase = 'finished'),
    'paper', paper, 'winner', winner, 'events', events
  );
end
$$;

create function quiz_pk_private.arena_state()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  pair uuid := quiz_pk_private.current_arena_pair(actor);
  at_time timestamptz := statement_timestamp();
  latest quiz_pk_private.arenas;
  history jsonb := '[]'::jsonb;
begin
  if pair is null then return jsonb_build_object('match', null, 'history', history); end if;
  select a.* into latest from quiz_pk_private.arenas a where a.pair_id = pair order by a.created_at desc limit 1;
  if latest.id is null then return jsonb_build_object('match', null, 'history', history, 'pairId', pair); end if;
  select coalesce(jsonb_agg(quiz_pk_private.arena_summary(past.game, actor, at_time)
    order by (past.game).created_at desc), '[]'::jsonb) into history from (
    select a as game from quiz_pk_private.arenas a
      where a.pair_id = pair and a.id <> latest.id and quiz_pk_private.arena_phase(a, at_time) = 'finished'
      order by a.created_at desc limit 5
  ) past;
  return jsonb_build_object('match', quiz_pk_private.arena_summary(latest, actor, at_time),
    'history', history, 'pairId', pair);
end
$$;

create function quiz_pk_private.arena_lock(match uuid, actor uuid)
returns quiz_pk_private.arenas language plpgsql set search_path = '' as $$
declare
  game quiz_pk_private.arenas;
begin
  select a.* into game from quiz_pk_private.arenas a
    where a.id = match and a.pair_id = quiz_pk_private.current_arena_pair(actor) for update;
  if game.id is null then raise exception 'arena_unavailable' using errcode = '42501'; end if;
  return game;
end
$$;

create function quiz_pk_private.arena_create(p_chapter text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  pair uuid := quiz_pk_private.current_arena_pair(actor);
  at_time timestamptz;
  game quiz_pk_private.arenas;
  partner uuid;
  ids text[];
begin
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
    order by random() limit 10) into ids;
  if cardinality(ids) = 0 then raise exception 'arena_chapter_empty' using errcode = '22023'; end if;
  insert into quiz_pk_private.arenas (pair_id, host_id, chapter, question_ids, created_at, expires_at)
    values (pair, actor, p_chapter, ids, at_time, at_time + interval '3 minutes') returning * into game;
  insert into quiz_pk_private.arena_players (match_id, account_id, ready_at)
    values (game.id, actor, at_time), (game.id, partner, null);
  delete from quiz_pk_private.arena_voice_signals where created_at < at_time - interval '2 minutes';
  perform quiz_pk_private.arena_tick(pair);
  return quiz_pk_private.arena_state();
end
$$;

create function quiz_pk_private.arena_join(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  game quiz_pk_private.arenas := quiz_pk_private.arena_lock(p_match_id, actor);
  at_time timestamptz := clock_timestamp();
begin
  if quiz_pk_private.arena_phase(game, at_time) = 'waiting' and game.host_id <> actor then
    update quiz_pk_private.arena_players set ready_at = at_time where match_id = game.id and account_id = actor;
    update quiz_pk_private.arenas set starts_at = at_time + interval '3 seconds',
      expires_at = at_time + interval '93 seconds' where id = game.id;
    insert into quiz_pk_private.arena_events (match_id, account_id, kind) values (game.id, actor, 'ready');
    perform quiz_pk_private.arena_tick(game.pair_id);
  end if;
  return quiz_pk_private.arena_state();
end
$$;

create function quiz_pk_private.arena_answer(p_match_id uuid, p_question_id text, p_choice text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  game quiz_pk_private.arenas := quiz_pk_private.arena_lock(p_match_id, actor);
  at_time timestamptz := clock_timestamp();
  own quiz_pk_private.arena_players;
  question quiz_pk_private.questions;
  elapsed integer;
  is_right boolean;
  is_critical boolean;
  damage_dealt integer := 0;
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
  own.combo := case when is_right then own.combo + 1 else 0 end;
  is_critical := is_right and (elapsed <= 3500 or own.combo >= 3);
  if is_right then
    damage_dealt := 8 + greatest(0, 5 - (elapsed / 1000)) + least(6, (own.combo - 1) * 2);
    own.correct := own.correct + 1;
    update quiz_pk_private.arena_players p set shield = greatest(0, p.shield - damage_dealt)
      where p.match_id = game.id and p.account_id <> actor;
  else
    own.missed_ids := array_append(own.missed_ids, p_question_id);
  end if;
  own.done := own.correct + cardinality(own.missed_ids) = cardinality(game.question_ids);
  update quiz_pk_private.arena_players p set
    picks = p.picks || jsonb_build_object(p_question_id, p_choice), missed_ids = own.missed_ids,
    correct = own.correct, combo = own.combo, best_combo = greatest(own.combo, p.best_combo),
    damage = p.damage + damage_dealt, time_ms = p.time_ms + elapsed,
    last_answer_at = at_time, done = own.done
    where p.match_id = game.id and p.account_id = actor;
  insert into quiz_pk_private.arena_events (match_id, account_id, kind, damage, combo, critical)
    values (game.id, actor, case when is_right then 'hit' else 'miss' end, damage_dealt, own.combo, is_critical);
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

create function quiz_pk_private.arena_react(p_match_id uuid, p_reaction text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  game quiz_pk_private.arenas := quiz_pk_private.arena_lock(p_match_id, actor);
  at_time timestamptz := clock_timestamp();
begin
  if p_reaction is null or p_reaction not in ('nice','letsgo','close','gg') then
    raise exception 'arena_invalid_reaction' using errcode = '22023';
  end if;
  if quiz_pk_private.arena_phase(game, at_time) in ('waiting', 'countdown', 'active')
    and not exists (select 1 from quiz_pk_private.arena_events e where e.match_id = game.id and e.account_id = actor
      and e.kind = 'message' and e.sent_at >= at_time - interval '2 seconds') then
    insert into quiz_pk_private.arena_events (match_id, account_id, kind, reaction)
      values (game.id, actor, 'message', p_reaction);
    perform quiz_pk_private.arena_tick(game.pair_id);
  end if;
  return quiz_pk_private.arena_state();
end
$$;

create function quiz_pk_private.arena_leave(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  game quiz_pk_private.arenas := quiz_pk_private.arena_lock(p_match_id, actor);
  at_time timestamptz := clock_timestamp();
  phase text := quiz_pk_private.arena_phase(game, at_time);
begin
  if phase = 'waiting' or phase = 'countdown' then
    update quiz_pk_private.arenas set cancelled_at = at_time where id = game.id;
  elsif phase = 'active' then
    update quiz_pk_private.arena_players set done = true, forfeited = true
      where match_id = game.id and account_id = actor and not done;
  else
    return quiz_pk_private.arena_state();
  end if;
  delete from quiz_pk_private.arena_voice_signals where match_id = game.id;
  perform quiz_pk_private.arena_tick(game.pair_id);
  return quiz_pk_private.arena_state();
end
$$;

create function quiz_pk_private.arena_voice(match_id uuid, session_id uuid, after_seq bigint default 0, signal jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  game quiz_pk_private.arenas;
  at_time timestamptz := clock_timestamp();
  mine uuid := session_id;
  peer uuid;
  inbox jsonb := '[]'::jsonb;
  highwater bigint := greatest(0, coalesce(after_seq, 0));
  signal_kind text := signal->>'kind';
  signal_payload jsonb := signal->'data';
begin
  if mine is null then raise exception 'arena_invalid_voice_session' using errcode = '22023'; end if;
  select a.* into game from quiz_pk_private.arenas a
    where a.id = arena_voice.match_id and a.pair_id = quiz_pk_private.current_arena_pair(actor);
  if game.id is null then raise exception 'arena_unavailable' using errcode = '42501'; end if;
  if quiz_pk_private.arena_phase(game, at_time) <> 'active' then
    delete from quiz_pk_private.arena_voice_signals s where s.match_id = game.id;
    return jsonb_build_object('ack', highwater, 'active', false, 'peerSessionId', null, 'signals', inbox);
  end if;
  insert into quiz_pk_private.arena_voice_sessions as old (match_id, account_id, session_id, heartbeat_at)
    values (game.id, actor, mine, at_time)
    on conflict on constraint arena_voice_sessions_pkey do update
    set session_id = excluded.session_id, heartbeat_at = excluded.heartbeat_at, closed = false
    where (old.session_id = mine and not old.closed) or
      (old.session_id <> mine and (old.closed or old.heartbeat_at < at_time - interval '9 seconds'));
  if not found then raise exception 'arena_voice_busy'; end if;
  select s.session_id into peer from quiz_pk_private.arena_voice_sessions s
    where s.match_id = game.id and s.account_id <> actor and not s.closed
      and s.heartbeat_at >= at_time - interval '9 seconds';
  if signal is not null then
    if signal_kind is null or signal_kind not in ('offer','answer','ice')
      or jsonb_typeof(signal_payload) is distinct from 'object' or octet_length(signal_payload::text) > 14000 then
      raise exception 'arena_invalid_voice_signal' using errcode = '22023';
    end if;
    if peer is not null and signal->>'peerSessionId' = peer::text
      and not exists (select 1 from quiz_pk_private.arena_voice_signals s
        where s.match_id = game.id and s.session_id = mine and s.peer_session_id = peer
          and s.kind = signal_kind and s.payload = signal_payload)
      and (select count(*) from quiz_pk_private.arena_voice_signals s where s.match_id = game.id
        and s.session_id = mine and s.peer_session_id = peer) < 160 then
      insert into quiz_pk_private.arena_voice_signals (match_id, session_id, peer_session_id, kind, payload)
        values (game.id, mine, peer, signal_kind, signal_payload);
    end if;
  end if;
  if peer is not null then
    select coalesce(max(s.seq), highwater), coalesce(jsonb_agg(jsonb_build_object(
      'seq', s.seq, 'sessionId', s.session_id, 'kind', s.kind, 'data', s.payload
    ) order by s.seq), '[]'::jsonb) into highwater, inbox from (
      select * from quiz_pk_private.arena_voice_signals s
      where s.match_id = game.id and s.peer_session_id = mine and s.session_id = peer and s.seq > highwater
      order by s.seq limit 32
    ) s;
  end if;
  return jsonb_build_object('ack', highwater, 'active', true, 'peerSessionId', peer, 'signals', inbox);
end
$$;

create function quiz_pk_private.arena_voice_leave(match_id uuid, session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := quiz_pk_private.require_member();
  match uuid := match_id;
  mine uuid := session_id;
begin
  update quiz_pk_private.arena_voice_sessions s set closed = true, heartbeat_at = clock_timestamp()
    where s.match_id = match and s.session_id = mine and s.account_id = actor;
  if found then
    delete from quiz_pk_private.arena_voice_signals s where s.match_id = match and (s.session_id = mine or s.peer_session_id = mine);
  end if;
end
$$;

create function public.quiz_arena_state()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select quiz_pk_private.arena_state()
$$;
create function public.quiz_arena_create(p_chapter text default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select quiz_pk_private.arena_create(p_chapter)
$$;
create function public.quiz_arena_join(p_match_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select quiz_pk_private.arena_join(p_match_id)
$$;
create function public.quiz_arena_answer(p_match_id uuid, p_question_id text, p_choice text[])
returns jsonb language sql security invoker set search_path = '' as $$
  select quiz_pk_private.arena_answer(p_match_id, p_question_id, p_choice)
$$;
create function public.quiz_arena_react(p_match_id uuid, p_reaction text)
returns jsonb language sql security invoker set search_path = '' as $$
  select quiz_pk_private.arena_react(p_match_id, p_reaction)
$$;
create function public.quiz_arena_leave(p_match_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select quiz_pk_private.arena_leave(p_match_id)
$$;
create function public.quiz_arena_voice(match_id uuid, session_id uuid, after_seq bigint default 0, signal jsonb default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select quiz_pk_private.arena_voice(match_id, session_id, after_seq, signal)
$$;
create function public.quiz_arena_voice_leave(match_id uuid, session_id uuid)
returns void language sql security invoker set search_path = '' as $$
  select quiz_pk_private.arena_voice_leave(match_id, session_id)
$$;

revoke all on quiz_pk_private.arenas, quiz_pk_private.arena_players, quiz_pk_private.arena_events,
  quiz_pk_private.arena_voice_sessions, quiz_pk_private.arena_voice_signals from public, anon, authenticated;
revoke all on function quiz_pk_private.arena_can_watch(uuid),
  quiz_pk_private.arena_state(),
  quiz_pk_private.arena_create(text),
  quiz_pk_private.arena_join(uuid),
  quiz_pk_private.arena_answer(uuid,text,text[]),
  quiz_pk_private.arena_react(uuid,text),
  quiz_pk_private.arena_leave(uuid),
  quiz_pk_private.arena_voice(uuid,uuid,bigint,jsonb),
  quiz_pk_private.arena_voice_leave(uuid,uuid),
  quiz_pk_private.current_arena_pair(uuid),
  quiz_pk_private.arena_tick(uuid),
  quiz_pk_private.arena_phase(quiz_pk_private.arenas,timestamptz),
  quiz_pk_private.arena_player_summary(quiz_pk_private.arena_players,boolean),
  quiz_pk_private.arena_summary(quiz_pk_private.arenas,uuid,timestamptz),
  quiz_pk_private.arena_lock(uuid,uuid) from public, anon, authenticated;
grant execute on function quiz_pk_private.arena_can_watch(uuid),
  quiz_pk_private.arena_state(),
  quiz_pk_private.arena_create(text),
  quiz_pk_private.arena_join(uuid),
  quiz_pk_private.arena_answer(uuid,text,text[]),
  quiz_pk_private.arena_react(uuid,text),
  quiz_pk_private.arena_leave(uuid),
  quiz_pk_private.arena_voice(uuid,uuid,bigint,jsonb),
  quiz_pk_private.arena_voice_leave(uuid,uuid) to authenticated;
revoke all on function public.quiz_arena_state(),
  public.quiz_arena_create(text),
  public.quiz_arena_join(uuid),
  public.quiz_arena_answer(uuid,text,text[]),
  public.quiz_arena_react(uuid,text),
  public.quiz_arena_leave(uuid),
  public.quiz_arena_voice(uuid,uuid,bigint,jsonb),
  public.quiz_arena_voice_leave(uuid,uuid) from public, anon, authenticated;
grant execute on function public.quiz_arena_state(),
  public.quiz_arena_create(text),
  public.quiz_arena_join(uuid),
  public.quiz_arena_answer(uuid,text,text[]),
  public.quiz_arena_react(uuid,text),
  public.quiz_arena_leave(uuid),
  public.quiz_arena_voice(uuid,uuid,bigint,jsonb),
  public.quiz_arena_voice_leave(uuid,uuid) to authenticated;
