// SQL statements from the migrations, for check c's scan without --db. Unlike check f's splitter
// (migrations.ts), this one keeps string literals, quoted identifiers and dollar-quoted bodies
// ($$ ... $$, $tag$ ... $tag$) whole, so a semicolon inside a function body does not end its
// create statement, and it gives each statement a second text with those bodies blanked out, so a
// pattern matched against it sees only the statement's own SQL.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { MIGRATIONS_DIR } from './migrations.ts';

export interface SqlStatement {
  /** The statement, comments blanked out. */
  text: string;
  /** The same, with the contents of string literals and dollar-quoted bodies blanked out too. */
  code: string;
  /** The 1-based line the statement starts on. */
  line: number;
}

const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

/** Statements split on `;` outside comments, quotes and dollar-quoted bodies. Every offset and newline is kept. */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const text = sql.split('');
  const code = sql.split('');
  const blank = (chars: string[], from: number, to: number) => {
    for (let i = from; i < to; i++) if (chars[i] !== '\n') chars[i] = ' ';
  };
  const ends: number[] = [];

  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const to = end === -1 ? sql.length : end;
      blank(text, i, to);
      blank(code, i, to);
      i = to;
    } else if (c === '/' && next === '*') {
      // Block comments nest in Postgres.
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      blank(text, i, j);
      blank(code, i, j);
      i = j;
    } else if (c === "'") {
      // E'...' strings take backslash escapes; others only ''.
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      blank(code, i + 1, Math.min(j, sql.length));
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      i = j + 1;
    } else if (c === '$' && !/[\w$]/.test(sql[i - 1] ?? '')) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(sql)?.[0];
      if (!tag) {
        i++;
        continue;
      }
      const close = sql.indexOf(tag, i + tag.length);
      const end = close === -1 ? sql.length : close;
      blank(code, i + tag.length, end);
      i = close === -1 ? sql.length : close + tag.length;
    } else {
      if (c === ';') ends.push(i);
      i++;
    }
  }

  const cleanText = text.join('');
  const cleanCode = code.join('');
  const statements: SqlStatement[] = [];
  let start = 0;
  for (const end of [...ends, sql.length]) {
    const slice = cleanText.slice(start, end);
    if (slice.trim()) {
      const offset = start + slice.length - slice.trimStart().length;
      statements.push({ text: slice, code: cleanCode.slice(start, end), line: lineOf(sql, offset) });
    }
    start = end + 1;
  }
  return statements;
}

function lineOf(sql: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (sql[i] === '\n') line++;
  return line;
}

export interface MigrationFile {
  /** Relative to the repo, such as supabase/migrations/20260101000000_init.sql. */
  file: string;
  sql: string;
}

/** The repo's supabase/migrations/*.sql, in filename order; none when the folder is missing. */
export async function readMigrations(repoPath: string): Promise<MigrationFile[]> {
  let names: string[];
  try {
    names = await readdir(path.join(repoPath, MIGRATIONS_DIR));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
    throw error;
  }
  const migrations: MigrationFile[] = [];
  for (const name of names.filter((n) => n.endsWith('.sql')).sort()) {
    const file = `${MIGRATIONS_DIR}/${name}`;
    try {
      migrations.push({ file, sql: await readFile(path.join(repoPath, file), 'utf8') });
    } catch (error) {
      // A directory named *.sql, or a dangling symlink: not a migration this check can read.
      if (['EISDIR', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
  }
  return migrations;
}
