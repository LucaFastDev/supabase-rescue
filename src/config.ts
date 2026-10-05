import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';

/** The relative path of the Supabase CLI config, from the audited root. */
export const CONFIG_FILE = 'supabase/config.toml';

/** What the audit reads from supabase/config.toml. */
export interface SupabaseConfig {
  /** `[api] schemas`, as written; empty when the key or the section is absent. */
  apiSchemas: string[];
  /** `[auth.email] enable_confirmations`, when it is written. */
  enableConfirmations?: { value: boolean; line: number };
  /** Every `[functions.<name>]` with `verify_jwt = false`, in file order; absent when there is none. */
  publicFunctions?: { name: string; line: number }[];
}

/**
 * Reads `<repoPath>/supabase/config.toml`. Undefined when there is no such file; throws, naming
 * the file, when it exists but is not valid TOML.
 */
export async function readConfig(repoPath: string): Promise<SupabaseConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(repoPath, CONFIG_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  let toml: Record<string, unknown>;
  try {
    toml = parse(text);
  } catch (error) {
    throw new Error(`${CONFIG_FILE} is not valid TOML: ${firstLine(error)}`);
  }

  const config: SupabaseConfig = { apiSchemas: [] };
  const schemas = table(toml.api)?.schemas;
  if (Array.isArray(schemas)) {
    config.apiSchemas = schemas.filter((s): s is string => typeof s === 'string');
  }
  const confirmations = table(table(toml.auth)?.email)?.enable_confirmations;
  if (typeof confirmations === 'boolean') {
    config.enableConfirmations = { value: confirmations, line: lineOfKey(text, 'auth.email', 'enable_confirmations') };
  }
  const functions = table(toml.functions);
  const publicFunctions = Object.entries(functions ?? {})
    .filter(([, value]) => table(value)?.verify_jwt === false)
    .map(([name]) => ({ name, line: lineOfKey(text, `functions.${name}`, 'verify_jwt') }));
  if (publicFunctions.length > 0) config.publicFunctions = publicFunctions;
  return config;
}

/** `public`, then every schema in `[api] schemas`, without duplicates. */
export function exposedSchemas(config: SupabaseConfig | undefined): string[] {
  return [...new Set(['public', ...(config?.apiSchemas ?? [])])];
}

function table(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!;
}

/**
 * The 1-based line `key = …` is written on inside the `[section]` table. smol-toml gives no
 * positions, so this is a line scan: it finds the plain `[section]` header form, which is how the
 * Supabase CLI writes config.toml, and falls back to the first line naming the key, then to line 1.
 */
function lineOfKey(text: string, section: string, key: string): number {
  const lines = text.split('\n');
  const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/;
  const assignment = new RegExp(`^\\s*${key}\\s*=`);
  let current = '';
  for (const [i, line] of lines.entries()) {
    const match = header.exec(line);
    if (match) current = match[1]!.replace(/\s+/g, '');
    else if (current === section && assignment.test(line)) return i + 1;
  }
  const anywhere = lines.findIndex((line) => line.includes(key));
  return anywhere === -1 ? 1 : anywhere + 1;
}
