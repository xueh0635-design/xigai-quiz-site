-- Serialize with legacy pair mutations during cutover.
select pg_advisory_xact_lock(hashtext('quiz_pk_pairing'));

-- Older clients may still show these controls. Block the public wrappers and
-- their private implementations so those clients cannot change assignments.
revoke execute on function public.quiz_pk_create_invite(), public.quiz_pk_join(text), public.quiz_pk_unpair(),
  quiz_pk_private.create_invite(), quiz_pk_private.join_pair(text), quiz_pk_private.leave_pair()
  from public, anon, authenticated;

-- Retain the dashboard response shape for older clients.
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
  select count(*) into total_questions from quiz_pk_private.questions;

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

-- The production-only data cutover is preserved under ../operations/.
-- It is deliberately not replayed during a blank local database reset.
