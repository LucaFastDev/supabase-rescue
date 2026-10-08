-- Fixes check k: the customer-photos bucket was public, so anyone who had a photo's URL could
-- download it, whatever the read policy said. Private, the bucket serves a file only to a user
-- the policy "Staff read the customer photos they added" lets read it, and the customer's page
-- shows each photo through a signed URL, which expires.

update storage.buckets set public = false where id = 'customer-photos';
