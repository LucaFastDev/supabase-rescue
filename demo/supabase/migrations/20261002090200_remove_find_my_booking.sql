-- Fixes check c: public.appointments_for_phone(text) ran with its owner's rights, anyone with the
-- anon key could call it, and it had no fixed search_path, so it listed the appointments of any
-- phone number past row level security. The "Find my booking" lookup it served is removed: the
-- booking page now shows a booking reference instead, and staff look bookings up for customers.

drop function public.appointments_for_phone(text);
