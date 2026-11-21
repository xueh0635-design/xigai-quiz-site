create function public.merge_account_quiz_state(expected_account uuid, changes jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
begin
  if actor is null or actor is distinct from expected_account or not exists (select 1 from public.quiz_members where account_id = actor) then
    raise exception 'account not enrolled' using errcode = '42501';
  end if;
  if jsonb_typeof(changes) is distinct from 'array'
    or jsonb_array_length(changes) > 100
    or octet_length(changes::text) > 350000 then
    raise exception 'invalid changes' using errcode = '22023';
  end if;

  insert into public.quiz_state as old (account_id, kind, record_key, revision, change_id, payload)
    select actor, entry.kind, entry.record_key, entry.revision, entry.change_id, entry.payload
    from jsonb_to_recordset(changes) as entry(
      kind text, record_key text, revision bigint, change_id uuid, payload jsonb
    )
    on conflict (account_id, kind, record_key) do update
    set revision = excluded.revision, change_id = excluded.change_id, payload = excluded.payload
    where (excluded.revision, excluded.change_id) > (old.revision, old.change_id);
end;
$$;

revoke all on function public.merge_account_quiz_state(uuid, jsonb) from public, anon;
grant execute on function public.merge_account_quiz_state(uuid, jsonb) to authenticated;

revoke execute on function public.merge_quiz_state(jsonb) from authenticated;
