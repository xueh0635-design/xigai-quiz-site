create or replace trigger enroll_direct_email_user
after insert or update of raw_app_meta_data on auth.users
for each row
when (new.raw_app_meta_data ->> 'quiz_enrollment' = 'direct-email-v1')
execute function quiz_internal.enroll_direct_email_user();

-- Restore membership for signups created while the trigger only ran at INSERT.
insert into public.quiz_members (account_id)
select id from auth.users
where raw_app_meta_data ->> 'quiz_enrollment' = 'direct-email-v1'
on conflict (account_id) do nothing;
