-- Customer photos: staff add photos of a customer's hair to the customer's page. The files are
-- in the storage bucket customer-photos, under the customer's id, and the page shows them by
-- their public URL.

insert into storage.buckets (id, name, public)
values ('customer-photos', 'customer-photos', true);

create policy "Staff add customer photos" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'customer-photos'
    and exists (select 1 from public.staff s where s.user_id = (select auth.uid()))
  );

-- FLAW (check k): the bucket is public, so anyone who has a photo's URL can download it whatever this policy says; it only limits what the API lists and returns, so the photos look private and are not.
create policy "Staff read the customer photos they added" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'customer-photos'
    and owner_id = (select auth.uid())::text
    and exists (select 1 from public.staff s where s.user_id = (select auth.uid()))
  );
