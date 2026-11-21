-- Historical deployment-only operation. Never run automatically on a new environment.
-- Requires an explicitly provisioned admin binding and the intended existing pair history.
-- Run on the project with the previously confirmed admin-to-peer binding.
-- Use the same transaction as the fixed desk migration on first deployment.
do $$
declare
  binding quiz_pk_private.admin_progress_access%rowtype;
  first_id uuid;
  second_id uuid;
  selected_pair uuid;
begin
  perform pg_advisory_xact_lock(hashtext('quiz_pk_pairing'));

  select * into strict binding from quiz_pk_private.admin_progress_access;
  if (select count(*) from auth.users
      where id in (binding.admin_account, binding.peer_account) and email_confirmed_at is not null) <> 2 then
    raise exception 'fixed desk accounts must both be confirmed';
  end if;
  first_id := least(binding.admin_account, binding.peer_account);
  second_id := greatest(binding.admin_account, binding.peer_account);

  if exists (
    select 1 from quiz_pk_private.active_pair_members m
    join quiz_pk_private.pairs p on p.id = m.pair_id
    where m.account_id in (first_id, second_id)
      and (p.first_account, p.second_account) <> (first_id, second_id)
  ) then
    raise exception 'fixed desk accounts have a conflicting assignment';
  end if;

  -- Reopen the existing pair with shared activity to retain its history.
  select p.id into strict selected_pair
    from quiz_pk_private.pairs p
    where (p.first_account, p.second_account) = (first_id, second_id)
      and (exists (select 1 from quiz_pk_private.duels d where d.pair_id = p.id)
        or exists (select 1 from quiz_pk_private.arenas a where a.pair_id = p.id)
        or exists (select 1 from quiz_pk_private.live_rooms r where r.pair_id = p.id)
        or exists (select 1 from quiz_pk_private.social_reactions s where s.pair_id = p.id));

  if exists (
    select 1 from quiz_pk_private.active_pair_members
    where account_id in (first_id, second_id) and pair_id <> selected_pair
  ) then
    raise exception 'fixed desk accounts are assigned to a different pair record';
  end if;

  update quiz_pk_private.pairs set closed_at = null
    where id = selected_pair and closed_at is not null;
  insert into quiz_pk_private.active_pair_members (account_id, pair_id)
    values (first_id, selected_pair), (second_id, selected_pair)
    on conflict (account_id) do nothing;

  if (select count(*) from quiz_pk_private.active_pair_members
      where pair_id = selected_pair and account_id in (first_id, second_id)) <> 2 then
    raise exception 'fixed desk assignment was incomplete';
  end if;
end;
$$;
