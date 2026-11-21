alter table public.quiz_state
  drop constraint quiz_state_kind_check,
  drop constraint quiz_state_check,
  add constraint quiz_state_kind_check
    check (kind in ('history', 'star', 'session', 'note')),
  add constraint quiz_state_check
    check (
      octet_length(payload::text) <= 240000 and
      (
        (kind = 'star' and jsonb_typeof(payload) = 'boolean')
        or (kind in ('history', 'session') and jsonb_typeof(payload) = 'object')
        or (kind = 'note' and jsonb_typeof(payload) = 'string' and char_length(payload #>> '{}') <= 8000)
      )
    );
