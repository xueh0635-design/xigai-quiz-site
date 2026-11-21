create table quiz_internal.tutor_attempts (
  account_id uuid primary key references auth.users(id) on delete cascade,
  day date not null,
  used smallint not null check (used between 1 and 24),
  last_request_at timestamptz not null
);
alter table quiz_internal.tutor_attempts enable row level security;
revoke all on quiz_internal.tutor_attempts from public, anon, authenticated;
grant select, insert, update on quiz_internal.tutor_attempts to service_role;

create function public.reserve_quiz_tutor_turn(tutor_user uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with claimed as (
    insert into quiz_internal.tutor_attempts as tally (account_id, day, used, last_request_at)
    values (tutor_user, timezone('Asia/Shanghai', statement_timestamp())::date, 1, statement_timestamp())
    on conflict (account_id) do update
    set day = excluded.day,
        used = case when tally.day = excluded.day then tally.used + 1 else 1 end,
        last_request_at = excluded.last_request_at
    where tally.day < excluded.day
      or (tally.day = excluded.day and tally.used < 24
          and tally.last_request_at <= excluded.last_request_at - interval '3 seconds')
    returning 1
  )
  select exists (select 1 from claimed);
$$;

revoke all on function public.reserve_quiz_tutor_turn(uuid) from public, anon, authenticated;
grant execute on function public.reserve_quiz_tutor_turn(uuid) to service_role;
