-- "Find my booking" on the booking page: a visitor types their phone number and sees their
-- upcoming appointments.

-- FLAW (check c): SECURITY DEFINER so that visitors can read appointments past RLS, executable by
-- anon (through PUBLIC's default grant), and with no fixed search_path. Anyone with the anon key
-- can list the appointments of any phone number, and the unqualified table names are looked up in
-- the caller's search_path.
create function public.appointments_for_phone(phone_number text)
returns table (starts_at timestamptz, service text, status text)
language sql
stable
security definer
as $$
  select a.starts_at, a.service, a.status
  from appointments a
  where a.customer_phone = phone_number
    and a.starts_at >= now() - interval '1 day'
  order by a.starts_at;
$$;
