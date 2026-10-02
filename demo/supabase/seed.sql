-- Seed data for the demo app: Juniper & Ash Hair Studio, a fictional salon. Every name, phone
-- number (Ofcom's range for drama, 07700 900xxx) and email address (example.com) is made up.
-- Appointments are placed around the current week, so the app always shows recent and upcoming
-- bookings.

-- Two staff accounts, signed in with email and password (see demo/README.md).
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', '6f1c2a3e-1d2b-4c5a-9e7f-0a1b2c3d4e01', 'authenticated', 'authenticated',
   'mia@example.com', extensions.crypt('salon-demo-password', extensions.gen_salt('bf')), now(),
   '{"provider": "email", "providers": ["email"]}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '6f1c2a3e-1d2b-4c5a-9e7f-0a1b2c3d4e02', 'authenticated', 'authenticated',
   'sam@example.com', extensions.crypt('salon-demo-password', extensions.gen_salt('bf')), now(),
   '{"provider": "email", "providers": ["email"]}', '{}', now(), now(), '', '', '', '');

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select u.id::text, u.id, jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), 'email', now(), now(), now()
from auth.users u
where u.email in ('mia@example.com', 'sam@example.com');

insert into public.staff (user_id, display_name)
values
  ('6f1c2a3e-1d2b-4c5a-9e7f-0a1b2c3d4e01', 'Mia Torres'),
  ('6f1c2a3e-1d2b-4c5a-9e7f-0a1b2c3d4e02', 'Sam Okafor');

insert into public.customers (full_name, phone, email)
values
  ('Aisha Rahman', '07700 900101', 'aisha.rahman@example.com'),
  ('Ben Carter', '07700 900102', 'ben.carter@example.com'),
  ('Chloe Nguyen', '07700 900103', 'chloe.nguyen@example.com'),
  ('Daniel Price', '07700 900104', null),
  ('Elena Rossi', '07700 900105', 'elena.rossi@example.com'),
  ('Farah Haddad', '07700 900106', 'farah.haddad@example.com'),
  ('George Mensah', '07700 900107', null),
  ('Hannah Webb', '07700 900108', 'hannah.webb@example.com'),
  ('Isaac Brennan', '07700 900109', 'isaac.brennan@example.com'),
  ('Jade Thompson', '07700 900110', 'jade.thompson@example.com'),
  ('Kofi Asante', '07700 900111', null),
  ('Lucy Fairbairn', '07700 900112', 'lucy.fairbairn@example.com');

-- day: days from Monday of the current week; at: local time in the salon.
insert into public.appointments (customer_name, customer_phone, customer_email, service, starts_at, status)
select c.full_name, c.phone, c.email, v.service,
       ((date_trunc('week', now())::date + v.day) + v.at::time) at time zone 'Europe/London',
       v.status
from (
  values
    ('07700 900101', 'Cut and finish', -21, '10:00', 'completed'),
    ('07700 900102', 'Beard trim', -21, '11:30', 'completed'),
    ('07700 900103', 'Colour', -20, '09:30', 'completed'),
    ('07700 900105', 'Balayage', -19, '13:00', 'completed'),
    ('07700 900108', 'Blow-dry', -18, '16:00', 'cancelled'),
    ('07700 900110', 'Cut and finish', -17, '10:30', 'completed'),
    ('07700 900104', 'Cut and finish', -14, '12:00', 'completed'),
    ('07700 900106', 'Colour', -13, '10:00', 'completed'),
    ('07700 900107', 'Beard trim', -13, '15:30', 'completed'),
    ('07700 900109', 'Kids cut', -12, '16:30', 'completed'),
    ('07700 900111', 'Cut and finish', -11, '11:00', 'cancelled'),
    ('07700 900112', 'Blow-dry', -10, '09:00', 'completed'),
    ('07700 900101', 'Blow-dry', -10, '14:00', 'completed'),
    ('07700 900103', 'Cut and finish', -7, '10:00', 'completed'),
    ('07700 900102', 'Cut and finish', -6, '12:30', 'completed'),
    ('07700 900105', 'Blow-dry', -6, '15:00', 'completed'),
    ('07700 900108', 'Colour', -5, '11:00', 'completed'),
    ('07700 900110', 'Balayage', -4, '13:30', 'completed'),
    ('07700 900106', 'Cut and finish', -3, '10:30', 'completed'),
    ('07700 900104', 'Beard trim', 0, '09:30', 'completed'),
    ('07700 900109', 'Cut and finish', 1, '11:00', 'confirmed'),
    ('07700 900111', 'Colour', 2, '14:00', 'confirmed'),
    ('07700 900112', 'Cut and finish', 3, '10:00', 'booked'),
    ('07700 900107', 'Beard trim', 4, '17:00', 'booked'),
    ('07700 900101', 'Cut and finish', 8, '10:00', 'booked'),
    ('07700 900105', 'Colour', 9, '12:00', 'booked'),
    ('07700 900110', 'Blow-dry', 11, '15:30', 'booked')
) as v(phone, service, day, at, status)
join public.customers c on c.phone = v.phone;

insert into public.staff_notes (customer_id, author_id, body)
select c.id, v.author::uuid, v.body
from (
  values
    ('07700 900101', '6f1c2a3e-1d2b-4c5a-9e7f-0a1b2c3d4e01', 'Prefers a quiet appointment, no small talk. Sensitive scalp: use the gentle shampoo.'),
    ('07700 900103', '6f1c2a3e-1d2b-4c5a-9e7f-0a1b2c3d4e01', 'Colour formula: 6.3 with 20 vol, 35 minutes.'),
    ('07700 900105', '6f1c2a3e-1d2b-4c5a-9e7f-0a1b2c3d4e02', 'Allergic to PPD: patch test 48 hours before any colour.'),
    ('07700 900108', '6f1c2a3e-1d2b-4c5a-9e7f-0a1b2c3d4e02', 'Cancelled twice at short notice. Ask for a deposit next time.'),
    ('07700 900110', '6f1c2a3e-1d2b-4c5a-9e7f-0a1b2c3d4e01', 'Balayage toner: 9.1 gloss. Wants it a little cooler next visit.'),
    ('07700 900112', '6f1c2a3e-1d2b-4c5a-9e7f-0a1b2c3d4e02', 'Getting married in the spring; book a trial in advance.')
) as v(phone, author, body)
join public.customers c on c.phone = v.phone;
