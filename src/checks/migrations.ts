// Check f: a migration that is not backward-compatible. The eight blocker rules and the statement
// splitting are ported from ai-hq's scripts/check-migration.mjs: patterns over SQL statements
// split on `;` with comments removed. Statements inside a dollar-quoted function body are split
// and checked too, so a function that truncates or drops at run time is caught. The warning rules
// and the `lane3-ok` waiver are not ported.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Finding } from '../findings.ts';
import type { Check } from './index.ts';

export const MIGRATIONS_DIR = 'supabase/migrations';

export interface Rule {
  id: string;
  title: string;
  test: (statement: string) => boolean;
  /** Why it matters, in a client's words. */
  message: string;
}

export const RULES: Rule[] = [
  {
    id: 'drop-column',
    title: 'Migration drops a column',
    test: (s) => /\bdrop\s+column\b/i.test(s),
    message:
      'It drops a column. A version of the app that still reads that column, including tabs your users already have open, starts failing the moment it runs, and the data in the column is gone. The safe order is to ship a release that stops using the column, then drop it in a later migration.',
  },
  {
    id: 'drop-table',
    title: 'Migration drops a table',
    test: (s) => /\bdrop\s+table\b/i.test(s),
    message:
      'It drops a table. Anything still querying that table breaks the moment it runs, and its rows are gone. Remove every use of the table in a shipped release first, then drop it in a later migration.',
  },
  {
    id: 'rename-column',
    title: 'Migration renames a column',
    test: (s) => /\brename\s+column\b/i.test(s),
    message:
      'It renames a column. The live app still asks for the old name and fails until the new version is deployed and every open tab reloads. Add the new column, copy the data across, move the app over, then drop the old one, in separate releases.',
  },
  {
    id: 'rename-table',
    title: 'Migration renames a table',
    test: (s) => /\balter\s+table\s+(if\s+exists\s+)?[\w".]+\s+rename\s+to\b/i.test(s),
    message:
      'It renames a table. The live app still queries the old name and fails until the new version is deployed. Create the new table, or a view under the new name, move the app over, then remove the old one.',
  },
  {
    id: 'set-not-null',
    title: 'Migration makes an existing column required',
    test: (s) => /\balter\s+column\s+"?\w+"?\s+set\s+not\s+null\b/i.test(s),
    message:
      'It makes an existing column required (NOT NULL). Any part of the live app that saves a row without that field starts failing. Enforce the field in the app instead and keep the column optional.',
  },
  {
    id: 'alter-type',
    title: "Migration changes a column's type",
    test: (s) => /\balter\s+column\s+"?\w+"?\s+(set\s+data\s+)?type\b/i.test(s),
    message:
      "It changes a column's type. Reads and writes from the live app can break, and on a large table the change locks it while every row is rewritten. Add a new column of the new type instead and move the app over to it.",
  },
  {
    id: 'add-not-null-no-default',
    title: 'Migration adds a required column without a default',
    test: (s) => addColumnNotNullWithoutDefault(s),
    message:
      'It adds a required (NOT NULL) column with no default. Any part of the live app that inserts a row without it starts failing. Make the column optional, or give it a default.',
  },
  {
    id: 'truncate',
    title: 'Migration deletes every row of a table',
    test: (s) => /\btruncate\b/i.test(s),
    message: 'It truncates a table: every row is deleted, and that cannot be undone.',
  },
];

// True if the statement adds a column that is NOT NULL, has no DEFAULT and is not generated.
function addColumnNotNullWithoutDefault(statement: string): boolean {
  const re = /\badd\s+column\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(statement)) !== null) {
    const clause = sliceToClauseEnd(statement.slice(match.index));
    if (/\bnot\s+null\b/i.test(clause) && !/\bdefault\b/i.test(clause) && !/\bgenerated\s+always\b/i.test(clause)) {
      return true;
    }
  }
  return false;
}

// Text up to the next comma outside parentheses: one column definition.
function sliceToClauseEnd(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) return text.slice(0, i);
  }
  return text;
}

// Comments blanked out, keeping every offset and newline in place.
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
}

export interface Statement {
  text: string;
  /** The 1-based line the statement starts on. */
  line: number;
}

/** Statements split on `;`, comments removed, each with the line it starts on. */
export function splitStatements(sql: string): Statement[] {
  const clean = stripComments(sql);
  const lineStarts = [0];
  for (let i = 0; i < sql.length; i++) if (sql[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const statements: Statement[] = [];
  const push = (from: number, to: number) => {
    const text = clean.slice(from, to);
    if (!text.trim()) return;
    statements.push({ text, line: lineAt(from + text.length - text.trimStart().length) });
  };
  let start = 0;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === ';') {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, clean.length);
  return statements;
}

/** Every rule hit in one SQL text, at the line its statement starts on. */
export function lintSql(sql: string): { rule: Rule; line: number }[] {
  return splitStatements(sql).flatMap((statement) =>
    RULES.filter((rule) => rule.test(statement.text)).map((rule) => ({ rule, line: statement.line })),
  );
}

/**
 * The pattern the suggested CI step matches new migrations against, case-insensitively: the same
 * eight rules, line by line, so a statement split over lines can slip past it.
 */
export const CI_PATTERN =
  String.raw`\bdrop\s+(column|table)\b|\brename\s+(column|to)\b|\bset\s+not\s+null\b|\balter\s+column\s+\S+\s+(set\s+data\s+)?type\b|\badd\s+column\b(?![^;,]*\b(default|generated\s+always)\b)[^;,]*\bnot\s+null\b|\btruncate\b`;

/**
 * The shell the suggested CI step runs. It matches with perl rather than `grep -P`, which BSD grep
 * (macOS) does not have: perl is on both macOS and GitHub's Ubuntu runners, and its regular
 * expressions are the ones PCRE copies. It fails closed: the added migrations are read
 * NUL-separated (never C-quoted, never word-split), and the step fails when it cannot list them,
 * when any file matches (perl exits 1, after printing file:line:text for each hit), or when perl
 * exits with anything but 0 or 1, such as 2 for a file it cannot open. Every failure names the file.
 */
export const CI_SCRIPT = `list=$(mktemp)
if ! git diff -z --name-only --diff-filter=A "origin/\${{ github.base_ref }}...HEAD" -- 'supabase/migrations/*.sql' > "$list"; then
  echo "::error::Could not list the migrations this pull request adds."
  exit 1
fi
status=0
while IFS= read -r -d '' file; do
  rc=0
  perl -e '
    my $file = shift;
    open(my $fh, "<", $file) or exit 2;
    my $hit = 0;
    while (my $line = <$fh>) {
      chomp $line;
      if ($line =~ /${CI_PATTERN}/i) { print "$file:$.:$line\\n"; $hit = 1; }
    }
    close($fh) or exit 2;
    exit $hit;
  ' -- "$file" || rc=$?
  if [ "$rc" -eq 1 ]; then
    echo "::error file=$file::$file is not backward-compatible: it drops, renames, retypes or truncates, or adds a required column without a default. Split it into backward-compatible steps."
    status=1
  elif [ "$rc" -ne 0 ]; then
    echo "::error file=$file::Could not check $file: perl exited $rc."
    status=1
  fi
done < "$list"
exit "$status"
`;

const CI_SNIPPET = `# .github/workflows/migration-check.yml
name: migration-check
on:
  pull_request:
    paths: ['supabase/migrations/**']
jobs:
  migrations:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: New migrations are backward-compatible
        shell: bash
        run: |
${CI_SCRIPT.replace(/^(?=.)/gm, '          ')}`;

export const migrationsCheck: Check = {
  id: 'f',
  async run({ repoPath }) {
    let names: string[];
    try {
      names = await readdir(path.join(repoPath, MIGRATIONS_DIR));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        return [];
      }
      throw error;
    }

    const findings: Finding[] = [];
    for (const name of names.filter((n) => n.endsWith('.sql')).sort()) {
      const file = `${MIGRATIONS_DIR}/${name}`;
      let sql: string;
      try {
        sql = await readFile(path.join(repoPath, file), 'utf8');
      } catch (error) {
        // A directory named *.sql, or a dangling symlink: not a migration this check can read.
        if (['EISDIR', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      for (const { rule, line } of lintSql(sql)) {
        findings.push({
          check: 'f',
          severity: 'low',
          title: rule.title,
          location: { file, line },
          why: `${rule.message} A migration that has been applied cannot be undone, so this is reported to catch the next one before it ships.`,
          fix: {
            text: 'Add a step to CI that fails a pull request whose new migrations are not backward-compatible. This one checks the migrations a pull request adds for the same patterns this check looks for, and fails too when it cannot check one.',
            snippet: { language: 'yaml', code: CI_SNIPPET },
          },
          checkBefore:
            'Whether this migration has already been applied to production. If it has, confirm the live app no longer depends on what it changed. If it has not, split it into backward-compatible steps before applying it.',
        });
      }
    }
    return findings;
  },
};
