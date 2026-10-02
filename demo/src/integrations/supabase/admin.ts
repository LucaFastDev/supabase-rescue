import { createClient } from "@supabase/supabase-js";

// FLAW (check d): the service-role key, written into frontend code to get the Customers list past
// row level security. It ships in the bundle to every visitor, and whoever reads it can read and
// change every row of every table. This is the local stack's well-known default key.
const SUPABASE_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

export const supabaseAdmin = createClient(import.meta.env.VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
