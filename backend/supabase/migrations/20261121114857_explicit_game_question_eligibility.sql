-- Explicit eligibility preserves the existing game catalog while allowing later
-- content migrations to retire changed or removed questions safely. Existing
-- rooms keep using the unchanged stored game options and answers.

create or replace function quiz_pk_private.start_duel(requested_chapter text)
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
    where q.live_enabled and q.correct_options is not null and (actual_chapter is null or q.chapter = actual_chapter)
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

create or replace function quiz_pk_private.live_command(operation text, target_room uuid default null,
  target_question text default null, chosen jsonb default null, requested_chapter text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
  active_pair_id uuid;
  room quiz_pk_private.live_rooms;
  question quiz_pk_private.questions;
  chapter_filter text := nullif(btrim(requested_chapter),'');
  question_list text[];
  picks text[];
  valid_picks boolean;
  all_ready boolean;
  changed boolean := false;
  occurred_at timestamptz;
begin
  if operation='state' then
    select p.id into active_pair_id from quiz_pk_private.pairs p
      join quiz_pk_private.active_pair_members m on m.pair_id=p.id
      where m.account_id=actor and p.closed_at is null for share of p;
    if active_pair_id is not null then perform quiz_pk_private.live_touch(actor,active_pair_id); end if;
    return quiz_pk_private.live_snapshot(actor,active_pair_id);
  end if;

  -- Serialize operations for a pair, including the existing unpair operation.
  select p.id into active_pair_id from quiz_pk_private.pairs p
    join quiz_pk_private.active_pair_members m on m.pair_id=p.id
    where m.account_id=actor and p.closed_at is null for update of p;
  if active_pair_id is null then raise exception 'live_pair_required' using errcode='42501'; end if;
  occurred_at := clock_timestamp();
  perform quiz_pk_private.live_touch(actor,active_pair_id);
  update quiz_pk_private.live_rooms r set status='expired', revision=r.revision+1
    where r.pair_id=active_pair_id and r.status in ('waiting','active') and r.expires_at<=occurred_at;

  if operation='start' then
    if exists (select 1 from quiz_pk_private.live_rooms r
      where r.pair_id=active_pair_id and r.status in ('waiting','active')) then
      return quiz_pk_private.live_snapshot(actor,active_pair_id);
    end if;
    if length(chapter_filter)>100 then raise exception 'live_chapter_unavailable' using errcode='22023'; end if;
    select array(
      select q.question_id from quiz_pk_private.questions q
      where q.live_enabled and q.correct_options is not null and (chapter_filter is null or q.chapter=chapter_filter)
      order by random() limit 5
    ) into question_list;
    if cardinality(question_list) <> 5 then raise exception 'live_chapter_unavailable' using errcode='22023'; end if;
    insert into quiz_pk_private.live_rooms
      (pair_id,created_by,chapter,question_ids,created_at,expires_at)
      values (active_pair_id,actor,chapter_filter,question_list,occurred_at,occurred_at+interval '2 hours');
    return quiz_pk_private.live_snapshot(actor,active_pair_id);
  end if;

  select r.* into room from quiz_pk_private.live_rooms r
    where r.id=target_room and r.pair_id=active_pair_id;
  if room.id is null then raise exception 'live_room_unavailable' using errcode='42501'; end if;
  if room.status in ('complete','ended','expired') then
    return quiz_pk_private.live_snapshot(actor,active_pair_id);
  end if;

  if operation='join' then
    if room.status='waiting' and room.created_by<>actor then
      update quiz_pk_private.live_rooms r
        set status='active',joined_at=occurred_at,revision=r.revision+1,expires_at=occurred_at+interval '2 hours'
        where r.id=room.id;
    end if;
  elsif operation='leave' then
    update quiz_pk_private.live_rooms r set status='ended',revision=r.revision+1 where r.id=room.id;
  elsif operation in ('answer','next') then
    if room.status<>'active' then raise exception 'live_not_ready'; end if;
    if target_question is distinct from room.question_ids[room.question_index] then
      return quiz_pk_private.live_snapshot(actor,active_pair_id);
    end if;

    if operation='answer' then
      if exists (select 1 from quiz_pk_private.live_answers a
        where a.room_id=room.id and a.question_id=target_question and a.account_id=actor) then
        return quiz_pk_private.live_snapshot(actor,active_pair_id);
      end if;
      if jsonb_typeof(chosen) is distinct from 'array' or octet_length(chosen::text)>512 then
        raise exception 'live_invalid_picks' using errcode='22023';
      end if;
      select q.* into question from quiz_pk_private.questions q where q.question_id=target_question;
      select array_agg(entry.value #>> '{}' order by entry.value #>> '{}'),
        count(*) between 1 and cardinality(question.options)
          and count(*)=count(distinct entry.value)
          and coalesce(bool_and(jsonb_typeof(entry.value)='string' and (entry.value #>> '{}')=any(question.options)),false)
        into picks, valid_picks from jsonb_array_elements(chosen) entry(value);
      if not valid_picks then raise exception 'live_invalid_picks' using errcode='22023'; end if;
      insert into quiz_pk_private.live_answers (room_id,account_id,question_id,picks,correct)
        values(room.id,actor,target_question,picks,picks<@question.correct_options and cardinality(picks)=cardinality(question.correct_options));
      changed := true;
    else
      if (select count(*) from quiz_pk_private.live_answers a
        where a.room_id=room.id and a.question_id=target_question)<>2 then
        raise exception 'live_not_ready';
      end if;
      update quiz_pk_private.live_answers a set ready=true
        where a.room_id=room.id and a.account_id=actor and a.question_id=target_question and not a.ready;
      changed := found;
      select count(*)=2 into all_ready from quiz_pk_private.live_answers a
        where a.room_id=room.id and a.question_id=target_question and a.ready;
    end if;

    if changed then
      update quiz_pk_private.live_rooms r set
        question_index=r.question_index+case when all_ready and r.question_index<cardinality(r.question_ids) then 1 else 0 end,
        status=case when all_ready and r.question_index=cardinality(r.question_ids) then 'complete' else r.status end,
        revision=r.revision+1, expires_at=occurred_at+interval '2 hours'
        where r.id=room.id;
    end if;
  else
    raise exception 'live_invalid_operation' using errcode='22023';
  end if;
  return quiz_pk_private.live_snapshot(actor,active_pair_id);
end;
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
    where q.arena_enabled and q.options is not null and (p_chapter is null or q.chapter = p_chapter)
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
