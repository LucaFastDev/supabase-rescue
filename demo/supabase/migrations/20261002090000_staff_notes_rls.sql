-- Fixes check a: public.staff_notes had row level security off, so anyone with the anon key could
-- read, change and delete every note. Only signed-in staff may use it now, with the same staff
-- check as the policies on customers and appointments. Nothing is granted to anon.

alter table public.staff_notes enable row level security;

create policy "Staff read notes" on public.staff_notes
  for select to authenticated
  using (exists (select 1 from public.staff s where s.user_id = (select auth.uid())));

create policy "Staff add notes" on public.staff_notes
  for insert to authenticated
  with check (exists (select 1 from public.staff s where s.user_id = (select auth.uid())));

create policy "Staff update notes" on public.staff_notes
  for update to authenticated
  using (exists (select 1 from public.staff s where s.user_id = (select auth.uid())))
  with check (exists (select 1 from public.staff s where s.user_id = (select auth.uid())));

create policy "Staff delete notes" on public.staff_notes
  for delete to authenticated
  using (exists (select 1 from public.staff s where s.user_id = (select auth.uid())));
