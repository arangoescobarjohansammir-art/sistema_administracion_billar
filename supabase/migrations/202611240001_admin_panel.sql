begin;

create table public.admin_snapshots (
  id text primary key check (id = 'club-patio-bonito'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload ->> 'version' = '1'),
  synced_at timestamptz not null default now()
);

alter table public.admin_snapshots enable row level security;
revoke all on public.admin_snapshots from public, anon, authenticated, service_role;
grant select on public.admin_snapshots to authenticated;
grant select, insert, update on public.admin_snapshots to service_role;

-- Membership is controlled by the project administrator via Auth app_metadata.
create policy "Administrador del club consulta la caja"
  on public.admin_snapshots for select to authenticated
  using ((select auth.jwt()) -> 'app_metadata' -> 'caja_admin' = 'true'::jsonb);

create function public.stamp_admin_snapshot() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.synced_at = clock_timestamp();
  return new;
end;
$$;
revoke all on function public.stamp_admin_snapshot() from public, anon, authenticated;
create trigger stamp_admin_snapshot before insert or update on public.admin_snapshots
  for each row execute function public.stamp_admin_snapshot();

commit;
