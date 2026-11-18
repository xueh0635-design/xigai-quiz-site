create table quiz_pk_private.live_presence (
  account_id uuid primary key references public.quiz_members(account_id) on delete cascade,
  pair_id uuid not null references quiz_pk_private.pairs(id) on delete cascade,
  seen_at timestamptz not null
);

create table quiz_pk_private.live_rooms (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references quiz_pk_private.pairs(id) on delete cascade,
  created_by uuid not null references public.quiz_members(account_id) on delete cascade,
  chapter text,
  question_ids text[] not null check (cardinality(question_ids) = 5),
  question_index smallint not null default 1 check (question_index between 1 and 5),
  status text not null default 'waiting' check (status in ('waiting','active','complete','ended','expired')),
  created_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > created_at),
  joined_at timestamptz,
  revision integer not null default 1 check (revision > 0)
);

create unique index quiz_live_one_active_room on quiz_pk_private.live_rooms (pair_id)
  where status in ('waiting','active');
create index quiz_live_recent_rooms on quiz_pk_private.live_rooms (pair_id, created_at desc, id desc);

create table quiz_pk_private.live_answers (
  room_id uuid not null references quiz_pk_private.live_rooms(id) on delete cascade,
  account_id uuid not null references public.quiz_members(account_id) on delete cascade,
  question_id text not null references quiz_pk_private.questions(question_id),
  picks text[] not null check (cardinality(picks) > 0),
  correct boolean not null,
  ready boolean not null default false,
  primary key (room_id, question_id, account_id)
);

alter table quiz_pk_private.live_presence enable row level security;
alter table quiz_pk_private.live_rooms enable row level security;
alter table quiz_pk_private.live_answers enable row level security;
revoke all on quiz_pk_private.live_presence, quiz_pk_private.live_rooms, quiz_pk_private.live_answers
  from public, anon, authenticated;

create function quiz_pk_private.live_touch(actor uuid, active_pair uuid)
returns void language sql set search_path = ''
as $$
  insert into quiz_pk_private.live_presence as entry (account_id, pair_id, seen_at)
    values (actor, active_pair, clock_timestamp())
  on conflict (account_id) do update set pair_id=excluded.pair_id, seen_at=excluded.seen_at
    where entry.pair_id <> excluded.pair_id or entry.seen_at <= excluded.seen_at - interval '7 seconds'
$$;

create function quiz_pk_private.live_snapshot(actor uuid, active_pair uuid)
returns jsonb language plpgsql set search_path = ''
as $$
declare
  partner uuid;
  room quiz_pk_private.live_rooms;
  mine quiz_pk_private.live_answers;
  theirs quiz_pk_private.live_answers;
  partner_online boolean;
  show_question boolean;
  revealed boolean;
  phase text;
  current_question text;
  correct_options text[];
  snapshot jsonb := null;
  summary jsonb;
begin
  -- Check pairing again before returning a private room snapshot.
  select case when p.first_account=actor then p.second_account else p.first_account end
    into partner
    from quiz_pk_private.pairs p
    join quiz_pk_private.active_pair_members membership on membership.pair_id=p.id
    where p.id=active_pair and p.closed_at is null and membership.account_id=actor
      and actor in (p.first_account,p.second_account);
  if partner is null then
    return jsonb_build_object('paired',false,'partnerOnline',false,'room',null);
  end if;

  select exists (
    select 1 from quiz_pk_private.live_presence presence
    where presence.account_id=partner and presence.pair_id=active_pair
      and presence.seen_at>clock_timestamp()-interval '20 seconds'
  ) into partner_online;
  select r.* into room from quiz_pk_private.live_rooms r
    where r.pair_id=active_pair order by r.created_at desc, r.id desc limit 1;

  if room.id is not null then
    phase := room.status;
    if phase in ('waiting','active') and room.expires_at<=clock_timestamp() then
      phase := 'expired';
    end if;
    show_question := phase='active';
    if show_question then
      current_question := room.question_ids[room.question_index];
      select a.* into mine from quiz_pk_private.live_answers a
        where a.room_id=room.id and a.account_id=actor and a.question_id=current_question;
      select a.* into theirs from quiz_pk_private.live_answers a
        where a.room_id=room.id and a.account_id=partner and a.question_id=current_question;
      revealed := mine.account_id is not null and theirs.account_id is not null;
      phase := case when revealed then 'reveal' else 'answering' end;
      if revealed then
        select q.correct_options into correct_options from quiz_pk_private.questions q
          where q.question_id=current_question;
      end if;
    end if;

    if phase='complete' then
      select jsonb_build_object(
        'myCorrect',count(*) filter (where a.correct),
        'partnerCorrect',count(*) filter (where b.correct),
        'bothCorrect',count(*) filter (where a.correct and b.correct),
        'review', jsonb_agg(jsonb_build_object('questionId',q.item,'myCorrect',a.correct,'partnerCorrect',b.correct) order by q.idx)
      ) into summary
      from unnest(room.question_ids) with ordinality as q(item,idx)
      join quiz_pk_private.live_answers a on a.room_id=room.id and a.question_id=q.item and a.account_id=actor
      join quiz_pk_private.live_answers b on b.room_id=room.id and b.question_id=q.item and b.account_id=partner;
    end if;

    snapshot := jsonb_build_object(
      'id',room.id,'chapter',room.chapter,'phase',phase,'index',room.question_index,
      'total',cardinality(room.question_ids),'questionId',current_question,
      'isHost',room.created_by=actor,'joined',room.created_by=actor or room.joined_at is not null,
      'myPicks',mine.picks,'partnerSubmitted',theirs.account_id is not null,
      'myReady',coalesce(mine.ready,false),'partnerReady',coalesce(theirs.ready,false),
      'correctPicks',correct_options,'partnerPicks',case when revealed then theirs.picks end,
      'mineCorrect',case when revealed then mine.correct end,
      'partnerCorrect',case when revealed then theirs.correct end,'summary',summary,
      'revision',room.revision,'createdAt',room.created_at,'expiresAt',room.expires_at
    );
  end if;
  return jsonb_build_object('paired',true,'partnerOnline',partner_online,'room',snapshot);
end;
$$;

create function quiz_pk_private.live_command(operation text, target_room uuid default null,
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
      where q.correct_options is not null and (chapter_filter is null or q.chapter=chapter_filter)
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

-- Keep answer and presence data entirely outside the public API-facing schema.
create function public.quiz_live_state()
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.live_command('state') $$;

create function public.quiz_live_start(chapter text default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.live_command('start', requested_chapter => chapter) $$;

create function public.quiz_live_join(room_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.live_command('join',room_id) $$;

create function public.quiz_live_answer(room_id uuid,question_id text,picks jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.live_command('answer',room_id,question_id,picks) $$;

create function public.quiz_live_next(room_id uuid,question_id text)
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.live_command('next',room_id,question_id) $$;

create function public.quiz_live_leave(room_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select quiz_pk_private.live_command('leave',room_id) $$;

revoke execute on function quiz_pk_private.live_touch(uuid,uuid), quiz_pk_private.live_snapshot(uuid,uuid),
  quiz_pk_private.live_command(text,uuid,text,jsonb,text) from public, anon, authenticated;
grant execute on function quiz_pk_private.live_command(text,uuid,text,jsonb,text) to authenticated;

revoke execute on function public.quiz_live_state(),public.quiz_live_start(text),public.quiz_live_join(uuid),
  public.quiz_live_answer(uuid,text,jsonb),public.quiz_live_next(uuid,text),public.quiz_live_leave(uuid)
  from public, anon, authenticated;
grant execute on function public.quiz_live_state(),public.quiz_live_start(text),public.quiz_live_join(uuid),
  public.quiz_live_answer(uuid,text,jsonb),public.quiz_live_next(uuid,text),public.quiz_live_leave(uuid)
  to authenticated;
