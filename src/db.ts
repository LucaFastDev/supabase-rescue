// The audit's database connection. Every connection opened from --db is read-only twice over: the
// session is started with default_transaction_read_only=on, and every query runs inside one
// BEGIN READ ONLY transaction. Either alone stops a write, even through a role that was wrongly
// granted one. The connection is closed on every path, and an error never shows the password.

import pg from 'pg';
import type { QueryResultRow } from 'pg';

/** The startup option that makes every transaction of the session read-only. */
export const READ_ONLY_OPTION = '-c default_transaction_read_only=on';

const CONNECT_TIMEOUT_MS = 15_000;

export type Query = <R extends QueryResultRow>(sql: string, params?: unknown[]) => Promise<R[]>;

/** An error from the database or the connection, with the password removed from its message. */
export class DatabaseError extends Error {}

/**
 * Connects to `url`, runs `fn` inside one BEGIN READ ONLY transaction, ends the transaction and
 * closes the connection. Any error, from the connection or a query, is thrown as a
 * DatabaseError whose message is one line without the password.
 */
export async function withReadOnlyDb<T>(url: string, fn: (query: Query) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: readOnlyUrl(url), connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  // pg also emits a lost connection as an 'error' event, which would crash the process unheard.
  // The pending or next query rejects with the same error, and that is what reports it.
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('begin read only');
    const query: Query = async (sql, params) => (await client.query(sql, params)).rows;
    const result = await fn(query);
    await client.query('commit');
    return result;
  } catch (error) {
    throw new DatabaseError(safeMessage(error, url));
  } finally {
    // Closing a connection that failed or was lost can itself fail; the socket is gone either
    // way, and the error that matters has already been thrown or the result returned.
    await client.end().catch(() => {});
  }
}

/**
 * The connection string with READ_ONLY_OPTION appended to its `options` parameter. pg lets the
 * connection string's own `options` override a separate setting, so the option goes into the
 * string itself, last, where it also overrides any earlier default_transaction_read_only.
 */
export function readOnlyUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DatabaseError('database: --db is not a valid postgresql:// connection string');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new DatabaseError('database: --db is not a valid postgresql:// connection string');
  }
  const existing = parsed.searchParams.get('options');
  parsed.searchParams.set('options', existing ? `${existing} ${READ_ONLY_OPTION}` : READ_ONLY_OPTION);
  return parsed.toString();
}

/** The error's first line, prefixed, with the connection string's password replaced by ***. */
export function safeMessage(error: unknown, url: string): string {
  return `database: ${redact(oneLine(error), passwords(url))}`;
}

function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message || error.name : String(error);
  return message.split('\n')[0]!.trim() || 'unknown error';
}

/** The password in the connection string, as written and decoded, when there is one. */
function passwords(url: string): string[] {
  const found = new Set<string>();
  const raw = /^[a-z]+:\/\/[^:@/]*:([^@/]*)@/i.exec(url)?.[1];
  if (raw) found.add(raw);
  try {
    const password = new URL(url).password;
    if (password) {
      found.add(password);
      found.add(decodeURIComponent(password));
    }
  } catch {
    // Not a URL: the raw match above is all there is.
  }
  return [...found].filter((p) => p.length > 0);
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((acc, secret) => acc.split(secret).join('***'), text);
}
