-- Send only a revision signal. Progress remains behind the existing aggregate RPCs.
create table public.quiz_desk_progress_ticks (
  account_id uuid primary key references public.quiz_members(account_id) on delete cascade,
  revision bigint not null default 1
);
alter table public.quiz_desk_progress_ticks enable row level security;
revoke all on public.quiz_desk_progress_ticks from public, anon, authenticated;
grant select on public.quiz_desk_progress_ticks to authenticated;

create function quiz_pk_private.can_watch_desk_progress(source_account uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select source_account = auth.uid()
    or source_account = quiz_pk_private.admin_progress_peer()
    or quiz_pk_private.current_arena_pair(source_account) = quiz_pk_private.current_arena_pair(auth.uid())
$$;
revoke all on function quiz_pk_private.can_watch_desk_progress(uuid) from public, anon, authenticated;
grant execute on function quiz_pk_private.can_watch_desk_progress(uuid) to authenticated;

create policy quiz_read_desk_progress_ticks on public.quiz_desk_progress_ticks
  for select to authenticated using (quiz_pk_private.can_watch_desk_progress(account_id));

create function quiz_pk_private.notify_desk_progress()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'history' then
    if tg_op = 'UPDATE'
      and new.payload->'wrong' is not distinct from old.payload->'wrong'
      and new.payload->'last' is not distinct from old.payload->'last'
      and new.payload->'review' is not distinct from old.payload->'review' then
      return null;
    end if;
  elsif new.kind = 'session' and new.record_key = 'resume' then
    if (tg_op = 'INSERT' and new.payload #> '{chapterStudy,tests}' is null)
      or (tg_op = 'UPDATE' and new.payload #> '{chapterStudy,tests}'
        is not distinct from old.payload #> '{chapterStudy,tests}') then
      return null;
    end if;
  else
    return null;
  end if;

  insert into public.quiz_desk_progress_ticks as tick (account_id) values (new.account_id)
  on conflict (account_id) do update set revision = tick.revision + 1;
  return null;
end;
$$;
revoke all on function quiz_pk_private.notify_desk_progress() from public, anon, authenticated;

create trigger quiz_notify_desk_progress
  after insert or update on public.quiz_state
  for each row when (new.kind in ('history', 'session'))
  execute function quiz_pk_private.notify_desk_progress();

alter publication supabase_realtime add table public.quiz_desk_progress_ticks;
