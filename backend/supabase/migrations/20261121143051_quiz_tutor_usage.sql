create table quiz_internal.tutor_usage (
  account_id uuid primary key references auth.users(id) on delete cascade,
  cost_nanos bigint not null default 0 check (cost_nanos >= 0),
  requests bigint not null default 0 check (requests >= 0)
);
alter table quiz_internal.tutor_usage enable row level security;
revoke all on quiz_internal.tutor_usage from public, anon, authenticated;
grant select, insert, update on quiz_internal.tutor_usage to service_role;

create function public.quiz_tutor_usage(tutor_user uuid, request_cost bigint default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  total quiz_internal.tutor_usage%rowtype;
begin
  if request_cost is null then
    select * into total from quiz_internal.tutor_usage where account_id = tutor_user;
  else
    insert into quiz_internal.tutor_usage as tally (account_id, cost_nanos, requests)
      values (tutor_user, request_cost, 1)
      on conflict (account_id) do update
      set cost_nanos = tally.cost_nanos + excluded.cost_nanos,
          requests = tally.requests + 1
      returning * into total;
  end if;
  return jsonb_build_object('costNanos', coalesce(total.cost_nanos, 0), 'requests', coalesce(total.requests, 0));
end;
$$;
revoke all on function public.quiz_tutor_usage(uuid, bigint) from public, anon, authenticated;
grant execute on function public.quiz_tutor_usage(uuid, bigint) to service_role;
