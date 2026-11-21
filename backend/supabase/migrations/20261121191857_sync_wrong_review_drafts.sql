-- The legacy merge RPC already applies account ownership and revision ordering.
-- Sync v2 already supports drafts; keep its broader constraints intact.
do $migration$
begin
  if to_regprocedure('public.quiz_sync_v2(uuid,jsonb,jsonb,bigint,integer)') is not null then
    return;
  end if;

  perform set_config('lock_timeout', '3s', true);
  alter table public.quiz_state
    drop constraint quiz_state_kind_check,
    drop constraint quiz_state_check,
    add constraint quiz_state_kind_check check (kind in ('history', 'star', 'session', 'note', 'draft')),
    add constraint quiz_state_check check (
      octet_length(payload::text) <= 240000 and (
        (kind = 'star' and jsonb_typeof(payload) = 'boolean')
        or (kind in ('history', 'session') and jsonb_typeof(payload) = 'object')
        or (kind = 'note' and jsonb_typeof(payload) = 'string' and char_length(payload #>> '{}') <= 8000)
        or (kind = 'draft' and (
          jsonb_typeof(payload) = 'object'
          and payload->'wrongBookReview' = 'true'::jsonb
          and payload->>'sid' = record_key
          and jsonb_typeof(payload->'ids') = 'array'
        ) is true)
      )
    );
end;
$migration$;
