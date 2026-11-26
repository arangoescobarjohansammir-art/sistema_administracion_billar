begin;

create table public.purchase_funding (
  id uuid primary key check (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  shift_id bigint not null check (shift_id between 1 and 9007199254740991),
  shift_opened_at timestamptz not null,
  amount integer not null check (amount between 1 and 1000000000),
  note text not null default '' check (char_length(note) <= 300),
  requested_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected')),
  movement_id bigint,
  result_note text not null default '',
  processed_at timestamptz,
  check (
    (status = 'pending' and movement_id is null and processed_at is null and result_note = '')
    or (status = 'applied' and movement_id > 0 and movement_id is not null and processed_at is not null and result_note = '')
    or (status = 'rejected' and movement_id is null and processed_at is not null and result_note <> '')
  )
);

create index purchase_funding_pending on public.purchase_funding (created_at, id) where status = 'pending';
create index purchase_funding_by_admin on public.purchase_funding (requested_by, created_at desc);

alter table public.purchase_funding enable row level security;
revoke all on public.purchase_funding from public, anon, authenticated, service_role;
grant select on public.purchase_funding to authenticated, service_role;
grant insert (id, shift_id, shift_opened_at, amount, note) on public.purchase_funding to authenticated;
grant update (status, movement_id, result_note, processed_at) on public.purchase_funding to service_role;

create policy "El administrador consulta sus aportes"
  on public.purchase_funding for select to authenticated
  using ((select auth.jwt()) -> 'app_metadata' -> 'caja_admin' = 'true'::jsonb and requested_by = (select auth.uid()));

create policy "El administrador registra aportes para el turno publicado"
  on public.purchase_funding for insert to authenticated
  with check (
    (select auth.jwt()) -> 'app_metadata' -> 'caja_admin' = 'true'::jsonb
    and requested_by = (select auth.uid())
    and exists (
      select 1 from public.admin_snapshots as snapshot
      where snapshot.id = 'club-patio-bonito'
        and (snapshot.payload #>> '{active,id}')::bigint = shift_id
        and (snapshot.payload #>> '{active,openedAt}')::timestamptz = shift_opened_at
    )
  );

commit;
