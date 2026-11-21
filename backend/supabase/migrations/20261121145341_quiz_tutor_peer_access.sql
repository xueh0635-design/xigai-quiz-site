create function public.quiz_tutor_peer_allowed(tutor_user uuid, tutor_owners uuid[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from quiz_pk_private.admin_progress_access as access
    join quiz_pk_private.active_pair_members as owner_pair
      on owner_pair.account_id = access.admin_account
    join quiz_pk_private.active_pair_members as peer_pair
      on peer_pair.account_id = access.peer_account
      and peer_pair.pair_id = owner_pair.pair_id
    where access.admin_account = any(tutor_owners)
      and access.peer_account = tutor_user
  );
$$;

revoke all on function public.quiz_tutor_peer_allowed(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.quiz_tutor_peer_allowed(uuid, uuid[]) to service_role;
