create schema quiz_internal;
revoke all on schema quiz_internal from public, anon, authenticated;
grant usage on schema quiz_internal to service_role;

create table quiz_internal.registration_attempts (
  window_start timestamptz not null,
  bucket text not null,
  attempts integer not null check (attempts > 0),
  primary key (window_start, bucket)
);

alter table quiz_internal.registration_attempts enable row level security;
grant select, insert, update, delete on quiz_internal.registration_attempts to service_role;

create function public.reserve_quiz_registration(caller_digest text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_window timestamptz := date_trunc('hour', now(), 'UTC');
begin
  if caller_digest is null or caller_digest !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  insert into quiz_internal.registration_attempts as tally (window_start, bucket, attempts)
    values (current_window, caller_digest, 1)
    on conflict (window_start, bucket) do update set attempts = tally.attempts + 1
    where tally.attempts < 5;
  if not found then
    return false;
  end if;

  delete from quiz_internal.registration_attempts where window_start < current_window - interval '1 day';

  insert into quiz_internal.registration_attempts as tally (window_start, bucket, attempts)
    values (current_window, 'global', 1)
    on conflict (window_start, bucket) do update set attempts = tally.attempts + 1
    where tally.attempts < 24;
  return found;
end;
$$;

revoke all on function public.reserve_quiz_registration(text) from public, anon, authenticated;
grant execute on function public.reserve_quiz_registration(text) to service_role;

-- Only the Auth Admin API sets app_metadata. Progress membership is created atomically with the user.
create function quiz_internal.enroll_direct_email_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.quiz_members (account_id) values (new.id)
    on conflict (account_id) do nothing;
  return new;
end;
$$;

revoke all on function quiz_internal.enroll_direct_email_user() from public, anon, authenticated;

create trigger enroll_direct_email_user
after insert on auth.users
for each row
when (new.raw_app_meta_data ->> 'quiz_enrollment' = 'direct-email-v1')
execute function quiz_internal.enroll_direct_email_user();
