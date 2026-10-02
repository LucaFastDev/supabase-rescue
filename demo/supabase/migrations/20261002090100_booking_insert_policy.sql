-- Fixes check b: the booking form's anon INSERT policy on public.appointments was
-- `with check (true)`, so a visitor could add any row, with any status and any time. A visitor
-- may now add only a new booking: one that starts in the future and is still unconfirmed
-- ('booked'). The status default already gives the form that value. Visitors still have no
-- policy to read, change or delete appointments.

drop policy "Anyone can book an appointment" on public.appointments;

create policy "Visitors book a future appointment" on public.appointments
  for insert to anon
  with check (starts_at > now() and status = 'booked');
