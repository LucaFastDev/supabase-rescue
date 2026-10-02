-- Staff notes move out of customers.notes into their own table, one row per note, with who wrote
-- it and when.

-- FLAW (check a): row level security is never enabled on this table, so with Supabase's default
-- grants anyone with the anon key can read, change and delete every note.
create table public.staff_notes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  author_id uuid default auth.uid() references public.staff (user_id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create index staff_notes_customer_id_idx on public.staff_notes (customer_id);

insert into public.staff_notes (customer_id, body, created_at)
select c.id, c.notes, c.created_at
from public.customers c
where c.notes is not null and c.notes <> '';

-- FLAW (check f): dropped in the same release that stops reading it, so a browser tab still
-- running the previous version fails on customers.notes the moment this runs.
alter table public.customers drop column notes;
