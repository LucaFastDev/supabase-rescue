-- Juniper & Ash Hair Studio: staff profiles, customers and appointments.

-- Staff profiles: one row per auth user who works at the salon.
create table public.staff (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

alter table public.staff enable row level security;

create policy "Staff read their own profile" on public.staff
  for select to authenticated
  using (user_id = (select auth.uid()));

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null unique,
  email text,
  notes text,
  created_at timestamptz not null default now()
);

alter table public.customers enable row level security;

create policy "Staff read customers" on public.customers
  for select to authenticated
  using (exists (select 1 from public.staff s where s.user_id = (select auth.uid())));

create policy "Staff update customers" on public.customers
  for update to authenticated
  using (exists (select 1 from public.staff s where s.user_id = (select auth.uid())))
  with check (exists (select 1 from public.staff s where s.user_id = (select auth.uid())));

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers (id) on delete cascade,
  customer_name text not null,
  customer_phone text not null,
  customer_email text,
  service text not null,
  starts_at timestamptz not null,
  status text not null default 'booked' check (status in ('booked', 'confirmed', 'completed', 'cancelled')),
  created_at timestamptz not null default now()
);

create index appointments_customer_id_idx on public.appointments (customer_id);
create index appointments_starts_at_idx on public.appointments (starts_at);

alter table public.appointments enable row level security;

-- FLAW (check b): the booking form inserts as anon, and this policy accepts any row at all from
-- anyone, with any status and any time, instead of checking what a visitor may book.
create policy "Anyone can book an appointment" on public.appointments
  for insert to anon
  with check (true);

create policy "Staff read appointments" on public.appointments
  for select to authenticated
  using (exists (select 1 from public.staff s where s.user_id = (select auth.uid())));

create policy "Staff add appointments" on public.appointments
  for insert to authenticated
  with check (exists (select 1 from public.staff s where s.user_id = (select auth.uid())));

create policy "Staff update appointments" on public.appointments
  for update to authenticated
  using (exists (select 1 from public.staff s where s.user_id = (select auth.uid())))
  with check (exists (select 1 from public.staff s where s.user_id = (select auth.uid())));

-- A booking names the visitor; this links it to their customer record, creating one for a new
-- phone number. It runs as its owner so that visitors need no access to customers. Only the
-- trigger calls it, so nobody is granted EXECUTE.
create function public.link_appointment_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.customers (full_name, phone, email)
  values (new.customer_name, new.customer_phone, new.customer_email)
  on conflict (phone) do nothing;

  select c.id into new.customer_id
  from public.customers c
  where c.phone = new.customer_phone;

  return new;
end;
$$;

revoke execute on function public.link_appointment_customer() from public, anon, authenticated;

create trigger appointments_link_customer
  before insert on public.appointments
  for each row execute function public.link_appointment_customer();
