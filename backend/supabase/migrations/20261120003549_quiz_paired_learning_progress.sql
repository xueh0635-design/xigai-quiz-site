-- Read the latest recorded attempt per question for the authenticated member and their current partner.
create function quiz_pk_private.paired_progress_details()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := quiz_pk_private.require_member();
  peer uuid;
  today date := (statement_timestamp() at time zone 'Asia/Shanghai')::date;
  first_ms bigint := (extract(epoch from ((today - 6)::timestamp at time zone 'Asia/Shanghai')) * 1000)::bigint;
  end_ms bigint := (extract(epoch from ((today + 1)::timestamp at time zone 'Asia/Shanghai')) * 1000)::bigint;
begin
  select case when pair.first_account = actor then pair.second_account else pair.first_account end
    into peer
    from quiz_pk_private.active_pair_members member
    join quiz_pk_private.pairs pair on pair.id = member.pair_id
    where member.account_id = actor
      and actor in (pair.first_account, pair.second_account) and pair.closed_at is null;

  if peer is null then
    return jsonb_build_object('paired', false, 'days', '[]'::jsonb, 'chapters', '[]'::jsonb);
  end if;

  return (
    with attempts as (
      select history.account_id, question.chapter, history.payload->'wrong' = 'false'::jsonb as correct,
        case when history.payload->>'last' ~ '^[0-9]{1,13}$'
          then (history.payload->>'last')::bigint end as last_ms
      from public.quiz_state history
      join quiz_pk_private.questions question on question.question_id = history.record_key
      where history.account_id in (actor, peer) and history.kind = 'history'
        and jsonb_typeof(history.payload->'wrong') = 'boolean'
    ), daily as (
      select (to_timestamp(last_ms / 1000.0) at time zone 'Asia/Shanghai')::date as day,
        count(*) filter (where account_id = actor) as mine,
        count(*) filter (where account_id = actor and correct) as mine_correct,
        count(*) filter (where account_id = peer) as theirs,
        count(*) filter (where account_id = peer and correct) as theirs_correct
      from attempts
      where last_ms >= first_ms and last_ms < end_ms
      group by 1
    ), chapter_activity as (
      select chapter, count(*) filter (where account_id = actor) as mine,
        count(*) filter (where account_id = actor and correct) as mine_correct,
        count(*) filter (where account_id = peer) as theirs,
        count(*) filter (where account_id = peer and correct) as theirs_correct
      from attempts
      group by chapter
    ), chapter_totals as (
      select chapter, count(*) as total
      from quiz_pk_private.questions
      group by chapter
    )
    select jsonb_build_object(
      'paired', true,
      'days', (
        select jsonb_agg(jsonb_build_object(
          'date', to_char(today - series.day_offset, 'YYYY-MM-DD'),
          'mine', coalesce(daily.mine, 0), 'mineCorrect', coalesce(daily.mine_correct, 0),
          'peer', coalesce(daily.theirs, 0), 'peerCorrect', coalesce(daily.theirs_correct, 0)
        ) order by series.day_offset)
        from generate_series(0, 6) as series(day_offset)
        left join daily on daily.day = today - series.day_offset
      ),
      'chapters', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'chapter', chapter_totals.chapter, 'total', chapter_totals.total,
          'mine', coalesce(chapter_activity.mine, 0), 'mineCorrect', coalesce(chapter_activity.mine_correct, 0),
          'peer', coalesce(chapter_activity.theirs, 0), 'peerCorrect', coalesce(chapter_activity.theirs_correct, 0)
        ) order by chapter_totals.chapter), '[]'::jsonb)
        from chapter_totals left join chapter_activity using (chapter)
      )
    )
  );
end;
$$;

create function public.quiz_pk_progress_details()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select quiz_pk_private.paired_progress_details() $$;

revoke execute on function quiz_pk_private.paired_progress_details(), public.quiz_pk_progress_details()
  from public, anon, authenticated;
grant execute on function quiz_pk_private.paired_progress_details(), public.quiz_pk_progress_details()
  to authenticated;
