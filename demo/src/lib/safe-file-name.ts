/**
 * A file name that can go into a storage key as it is. Storage refuses a key with a non-ASCII
 * character, and supabase-js does not encode the path, so a "#" or "?" would cut the key short.
 * Every character outside A-Z, a-z, 0-9, ".", "_" and "-" becomes "-", so the extension is kept.
 */
export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/gu, "-");
}
