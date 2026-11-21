-- An authenticated study member may publish only their own JPEG avatar.
-- The dashboard reads avatar revisions from the same Storage object metadata.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quiz-pk-avatars', 'quiz-pk-avatars', false, 131072, array['image/jpeg']);

create function quiz_pk_private.owns_avatar(object_path text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1 from public.quiz_members as member
    where member.account_id = (select auth.uid())
      and object_path = member.account_id::text || '.jpg'
  )
$$;

create function quiz_pk_private.can_read_avatar(object_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.quiz_members as member
    where member.account_id = (select auth.uid())
      and (
        object_path = member.account_id::text || '.jpg'
        or exists (
          select 1
          from quiz_pk_private.active_pair_members as own
          join quiz_pk_private.pairs as pair on pair.id = own.pair_id
          where own.account_id = member.account_id and pair.closed_at is null
            and object_path = (
              case when pair.first_account = member.account_id then pair.second_account
                else pair.first_account end
            )::text || '.jpg'
        )
      )
  )
$$;

revoke execute on function quiz_pk_private.owns_avatar(text),
  quiz_pk_private.can_read_avatar(text) from public, anon, authenticated;
grant execute on function quiz_pk_private.owns_avatar(text),
  quiz_pk_private.can_read_avatar(text) to authenticated;

create policy "Study desk members read own or paired avatar"
  on storage.objects for select to authenticated
  using (bucket_id = 'quiz-pk-avatars' and quiz_pk_private.can_read_avatar(name));

create policy "Study desk members upload own avatar"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'quiz-pk-avatars' and quiz_pk_private.owns_avatar(name));

create policy "Study desk members overwrite own avatar"
  on storage.objects for update to authenticated
  using (bucket_id = 'quiz-pk-avatars' and quiz_pk_private.owns_avatar(name))
  with check (bucket_id = 'quiz-pk-avatars' and quiz_pk_private.owns_avatar(name));

create policy "Study desk members remove own avatar"
  on storage.objects for delete to authenticated
  using (bucket_id = 'quiz-pk-avatars' and quiz_pk_private.owns_avatar(name));

-- The existing authenticated dashboard owns the scope for these metadata reads.
-- Do not grant direct access to study_stats or to the private storage metadata.
create or replace function quiz_pk_private.study_stats(account uuid, total_questions bigint)
returns jsonb
language sql
set search_path = ''
as $$
  with daily as (
    select extract(epoch from (
      date_trunc('day', statement_timestamp() at time zone 'Asia/Shanghai')
        at time zone 'Asia/Shanghai'
    )) * 1000 as start_ms
  ), stats as (
    select count(*) as answered,
      count(*) filter (where s.payload->'wrong' = 'false'::jsonb) as correct,
      count(*) filter (where case when (s.payload->>'last') ~ '^[0-9]{1,13}$'
        then (s.payload->>'last')::bigint >= daily.start_ms
          and (s.payload->>'last')::bigint < daily.start_ms + 86400000
        else false end) as today
    from public.quiz_state as s
    join quiz_pk_private.questions as q on q.question_id = s.record_key
    cross join daily
    where s.account_id = account and s.kind = 'history'
      and jsonb_typeof(s.payload->'wrong') = 'boolean'
  )
  select jsonb_build_object(
    'answered', answered, 'correct', correct, 'today', today,
    'accuracy', coalesce(round(100.0 * correct / nullif(answered, 0)), 0),
    'completion', coalesce(round(100.0 * answered / nullif(total_questions, 0)), 0),
    'avatar', (
      select jsonb_build_object('path', image.name, 'revision', image.updated_at)
      from storage.objects as image
      where image.bucket_id = 'quiz-pk-avatars' and image.name = account::text || '.jpg'
    )
  ) from stats
$$;
