// Check c: an exposed function. A SECURITY DEFINER function in an exposed schema that anon can
// execute (directly or through PUBLIC) is critical, one only signed-in users can execute is high.
// A SECURITY DEFINER function in any schema that is not skipped, with no search_path set, is
// medium. A SECURITY INVOKER function in an exposed schema that anon can execute is low. One
// finding per function, at its highest severity, naming every problem it has.
//
// Without --db it reads supabase/migrations/*.sql instead, and finds one problem only: a SECURITY
// DEFINER function in an exposed schema that the migrations do not revoke from both PUBLIC and
// anon, or that a migration grants to anon and no later one revokes from anon, is high. With --db
// the catalog is authoritative and the migrations are not read.

import { catalogFor } from '../catalog.ts';
import type { FunctionRow } from '../catalog.ts';
import { SEVERITIES } from '../findings.ts';
import type { Finding, Severity } from '../findings.ts';
import type { Check, CheckContext } from './index.ts';
import { qualified } from './sql.ts';
import { readMigrations, splitSqlStatements } from './sql-statements.ts';

export type FunctionProblemId = 'definer-anon' | 'definer-authenticated' | 'no-search-path' | 'invoker-anon';

export interface FunctionProblem {
  id: FunctionProblemId;
  severity: Severity;
}

/** Every problem the function has, most severe first. */
export function functionProblems(fn: FunctionRow): FunctionProblem[] {
  const problems: FunctionProblem[] = [];
  if (fn.definer && fn.exposed && fn.anon_can_execute) problems.push({ id: 'definer-anon', severity: 'critical' });
  else if (fn.definer && fn.exposed && fn.authenticated_can_execute) problems.push({ id: 'definer-authenticated', severity: 'high' });
  if (fn.definer && !fn.has_search_path) problems.push({ id: 'no-search-path', severity: 'medium' });
  if (!fn.definer && fn.exposed && fn.anon_can_execute) problems.push({ id: 'invoker-anon', severity: 'low' });
  return problems.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

export const functionsCheck: Check = {
  id: 'c',
  async run(context) {
    const catalog = catalogFor(context);
    if (!catalog) return repoOnlyFindings(context);
    const findings: Finding[] = [];
    for (const fn of (await catalog).functions) {
      const problems = functionProblems(fn);
      if (problems.length > 0) findings.push(exposedFunction(fn, problems));
    }
    return findings;
  },
};

interface ProblemText {
  title: (name: string) => string;
  why: string;
  sql: (signature: string) => string;
  checkBefore: string;
}

const REVOKE_ANON_CHECK =
  "Whether the app calls this function before sign-in (supabase.rpc on a page for visitors): after the revoke those calls fail with permission denied. Revoking from public also removes signed-in users' access if it came only through public, so keep the grant to authenticated if they need it.";

const TEXT: Record<FunctionProblemId, ProblemText> = {
  'definer-anon': {
    title: (name) => `Function ${name} runs with its owner's rights and anyone can call it`,
    why: "It is SECURITY DEFINER, so it runs with the rights of its owner, usually postgres, which row level security does not stop, and anyone who has your anon key, which ships inside your app to every visitor, can call it through the Data API. Whatever it reads or changes, any visitor can.",
    sql: (sig) =>
      `revoke execute on function ${sig} from anon, public;\ngrant execute on function ${sig} to authenticated; -- only if signed-in users need it\n`,
    checkBefore: REVOKE_ANON_CHECK,
  },
  'definer-authenticated': {
    title: (name) => `Function ${name} runs with its owner's rights and any signed-in user can call it`,
    why: "It is SECURITY DEFINER, so it runs with the rights of its owner, usually postgres, which row level security does not stop, and any signed-in user can call it through the Data API. Anyone can sign up, so whatever it reads or changes, any user can, for every customer's rows.",
    sql: (sig) =>
      `revoke execute on function ${sig} from authenticated;\n-- Or, if it does not need its owner's rights, let row level security apply to it:\n-- alter function ${sig} security invoker;\n`,
    checkBefore:
      'Whether signed-in users need this function. If they do, make it check inside its body that the caller may act on the rows it touches (for example against auth.uid()), or make it SECURITY INVOKER so their row level security policies apply.',
  },
  'no-search-path': {
    title: (name) => `Function ${name} runs with its owner's rights without a fixed search_path`,
    why: "It is SECURITY DEFINER and does not set its own search_path, so the names in its body are looked up in the caller's search path. A caller who can create objects in a schema on that path can make it run their own code with the owner's rights.",
    sql: (sig) => `alter function ${sig} set search_path = '';\n`,
    checkBefore:
      'With an empty search_path, every table, type and function the body uses must name its schema, such as public.bookings or auth.uid(). Check the body for unqualified names and run the function once after the change.',
  },
  'invoker-anon': {
    title: (name) => `Anyone can call function ${name}`,
    why: 'Anyone who has your anon key, which ships inside your app to every visitor, can call it through the Data API. It runs with the caller\'s rights, so row level security still applies, but check that visitors are meant to call it at all.',
    sql: (sig) => `revoke execute on function ${sig} from anon, public;\ngrant execute on function ${sig} to authenticated; -- only if signed-in users need it\n`,
    checkBefore: REVOKE_ANON_CHECK,
  },
};

const OWNER: Record<FunctionProblemId, string> = {
  'definer-anon': 'Anyone on the internet can run a database function with full rights.',
  'definer-authenticated': 'Any signed-in user can run a database function with full rights.',
  'no-search-path': 'A database function could be tricked into running the wrong code.',
  'invoker-anon': 'Anyone can call one of your database functions.',
};

function exposedFunction(fn: FunctionRow, problems: FunctionProblem[]): Finding {
  const name = `${fn.schema}.${fn.name}(${fn.args})`;
  const signature = `${qualified(fn.schema, fn.name)}(${fn.args})`;
  const texts = problems.map((p) => TEXT[p.id]);
  const several = texts.length > 1;
  return {
    check: 'c',
    severity: problems[0]!.severity,
    owner: OWNER[problems[0]!.id],
    title: texts[0]!.title(name),
    location: { object: name },
    why: several ? texts.map((t, i) => `${i + 1}. ${t.why}`).join(' ') : texts[0]!.why,
    fix: {
      text: several
        ? `It has ${texts.length} problems; the SQL fixes each, in the order above.`
        : 'The SQL below fixes it.',
      snippet: { language: 'sql', code: texts.map((t) => t.sql(signature)).join('\n') },
    },
    checkBefore: texts.map((t) => t.checkBefore).join(' '),
  };
}

// Without --db: the migrations' create function, drop function, grant and revoke statements, in
// order. `at` is a statement's position across every migration, in filename order.

interface Created {
  at: number;
  schema: string;
  name: string;
  /** The argument list as written, without defaults. */
  args: string;
  definer: boolean;
  file: string;
  line: number;
}

interface Privilege {
  at: number;
  grant: boolean;
  /** schema.name of each function it names, or none for `all functions in schema`. */
  functions: string[];
  /** The schemas of `all functions in schema`. */
  schemas: string[];
  roles: string[];
}

interface DefaultRevoke {
  at: number;
  /** The schemas of `in schema`, or null for every schema. */
  schemas: string[] | null;
  roles: string[];
}

const IDENT = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)`;
const NAME = new RegExp(String.raw`^\s*(${IDENT})(?:\s*\.\s*(${IDENT}))?`);
const CREATE = /^\s*create\s+(?:or\s+replace\s+)?function\s/i;
const DROP = /^\s*drop\s+function\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+(?:cascade|restrict))?\s*$/i;
const PRIVILEGE =
  /^\s*(grant|revoke)\s+(grant\s+option\s+for\s+)?(?:execute|all(?:\s+privileges)?)\s+on\s+(?:function\s+([\s\S]+?)|all\s+functions\s+in\s+schema\s+([\s\S]+?))\s+(?:to|from)\s+([\s\S]+)$/i;
const DEFAULT_REVOKE =
  /^\s*alter\s+default\s+privileges\s+(?:for\s+(?:role|user)\s+[\s\S]+?\s+)?(?:in\s+schema\s+([\s\S]+?)\s+)?revoke\s+(grant\s+option\s+for\s+)?(?:execute|all(?:\s+privileges)?)\s+on\s+functions\s+from\s+([\s\S]+)$/i;

/** An identifier without its double quotes, lower-cased: names compare case-insensitively. */
function unquote(ident: string): string {
  return (ident.startsWith('"') ? ident.slice(1, -1).replace(/""/g, '"') : ident).toLowerCase();
}

/** schema.name of a function name as written; an unqualified name is in public. */
function functionKey(written: string): string | undefined {
  const match = NAME.exec(written);
  if (!match) return undefined;
  return match[2] === undefined ? `public.${unquote(match[1]!)}` : `${unquote(match[1]!)}.${unquote(match[2])}`;
}

/** The items of a comma-separated list, split outside parentheses and double quotes. */
function splitList(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '(') depth++;
    else if (!quoted && c === ')') depth--;
    else if (!quoted && depth === 0 && c === ',') {
      items.push(list.slice(start, i));
      start = i + 1;
    }
  }
  items.push(list.slice(start));
  return items.map((item) => item.trim()).filter(Boolean);
}

function roleList(written: string): string[] {
  const roles = written
    .replace(/\s+(?:cascade|restrict)\s*$/i, '')
    .replace(/\s+granted\s+by\s[\s\S]*$/i, '')
    .replace(/\s+with\s+grant\s+option\s*$/i, '');
  return splitList(roles).map((role) => unquote(role.replace(/^group\s+/i, '')));
}

function parseCreate(code: string, file: string, line: number, at: number): Created | undefined {
  const head = CREATE.exec(code);
  if (!head) return undefined;
  const rest = code.slice(head[0].length);
  const name = NAME.exec(rest);
  if (!name || !/^\s*\(/.test(rest.slice(name[0].length))) return undefined;
  const key = functionKey(rest)!;
  const open = head[0].length + rest.indexOf('(', name[0].length);
  let close = open;
  for (let depth = 0; close < code.length; close++) {
    if (code[close] === '(') depth++;
    else if (code[close] === ')' && --depth === 0) break;
  }
  const args = splitList(code.slice(open + 1, close))
    .map((arg) => arg.replace(/\s*(?:\bdefault\b|=)[\s\S]*$/i, '').replace(/\s+/g, ' '))
    .join(', ');
  const dot = key.indexOf('.');
  return {
    at,
    schema: key.slice(0, dot),
    name: key.slice(dot + 1),
    args,
    definer: /\bsecurity\s+definer\b/i.test(code.slice(close + 1)),
    file,
    line,
  };
}

async function repoOnlyFindings(context: CheckContext): Promise<Finding[]> {
  const created = new Map<string, Created>();
  const dropped = new Map<string, number>();
  const privileges: Privilege[] = [];
  const defaultRevokes: DefaultRevoke[] = [];

  let at = 0;
  for (const { file, sql } of await readMigrations(context.repoPath)) {
    for (const { code, line } of splitSqlStatements(sql)) {
      at++;
      const create = parseCreate(code, file, line, at);
      if (create) {
        created.set(`${create.schema}.${create.name}`, create);
        continue;
      }
      const drop = DROP.exec(code);
      if (drop) {
        for (const item of splitList(drop[1]!)) {
          const key = functionKey(item);
          if (key) dropped.set(key, at);
        }
        continue;
      }
      const privilege = PRIVILEGE.exec(code);
      // `revoke grant option for` leaves the privilege itself in place.
      if (privilege && !privilege[2]) {
        privileges.push({
          at,
          grant: privilege[1]!.toLowerCase() === 'grant',
          functions: privilege[3] ? splitList(privilege[3]).flatMap((item) => functionKey(item) ?? []) : [],
          schemas: privilege[4] ? splitList(privilege[4]).map(unquote) : [],
          roles: roleList(privilege[5]!),
        });
        continue;
      }
      const defaults = DEFAULT_REVOKE.exec(code);
      if (defaults && !defaults[2]) {
        defaultRevokes.push({ at, schemas: defaults[1] ? splitList(defaults[1]).map(unquote) : null, roles: roleList(defaults[3]!) });
      }
    }
  }

  const exposed = new Set(context.exposedSchemas.map((s) => s.toLowerCase()));
  const findings: Finding[] = [];
  for (const [key, fn] of created) {
    if (!fn.definer || !exposed.has(fn.schema) || (dropped.get(key) ?? 0) > fn.at) continue;
    const revokes = privileges.filter((p) => !p.grant);
    // A revoke that removes `role`'s execute on this function, placed after `after`.
    const revokedFrom = (role: string, after: number) =>
      revokes.some((p) => p.at > after && p.roles.includes(role) && (p.functions.includes(key) || p.schemas.includes(fn.schema)));
    // Whether the migrations revoke `role`'s execute on this function, in any of the three forms.
    const revoked = (role: string) =>
      revokes.some((p) => p.roles.includes(role) && (p.functions.includes(key) || (p.at > fn.at && p.schemas.includes(fn.schema)))) ||
      defaultRevokes.some((d) => d.at < fn.at && d.roles.includes(role) && (d.schemas === null || d.schemas.includes(fn.schema)));
    // On Supabase, default privileges in public grant anon its own EXECUTE on each new function, so
    // a revoke from PUBLIC alone still leaves anon able to call it.
    const covered = revoked('public') && revoked('anon');
    const grantedToAnon = privileges.some(
      (p) => p.grant && p.functions.includes(key) && p.roles.includes('anon') && !revokedFrom('anon', p.at),
    );
    if (covered && !grantedToAnon) continue;
    findings.push(repoOnlyFinding(fn, grantedToAnon ? 'granted-to-anon' : revoked('public') ? 'anon-not-revoked' : 'public-not-revoked'));
  }
  return findings;
}

type RepoOnlyReason = 'granted-to-anon' | 'public-not-revoked' | 'anon-not-revoked';

const ANON_ROLE = 'anon, the role of anyone who has your anon key, which ships inside your app to every visitor,';

const REPO_ONLY_REASON: Record<RepoOnlyReason, string> = {
  'granted-to-anon': `A migration grants EXECUTE on it to ${ANON_ROLE} and no later migration revokes it.`,
  'public-not-revoked': `Postgres lets PUBLIC execute every new function, and no migration revokes that, so ${ANON_ROLE} can execute it through PUBLIC, since anon is a member of PUBLIC. A grant to authenticated does not take it away.`,
  'anon-not-revoked': `The migrations revoke EXECUTE on it from PUBLIC but not from anon. On Supabase, default privileges give ${ANON_ROLE} its own EXECUTE on a new function, as they do in public, so a revoke from PUBLIC alone does not stop anon executing it.`,
};

function repoOnlyFinding(fn: Created, why: RepoOnlyReason): Finding {
  const signature = `${qualified(fn.schema, fn.name)}(${fn.args})`;
  const reason = REPO_ONLY_REASON[why];
  return {
    check: 'c',
    severity: 'high',
    owner: OWNER['definer-anon'],
    title: `Function ${fn.schema}.${fn.name} runs with its owner's rights and the migrations let anyone call it`,
    location: { file: fn.file, line: fn.line },
    why: `It is SECURITY DEFINER, so it runs with the rights of its owner, usually postgres, which row level security does not stop. ${reason} So any visitor can call it through the Data API. This audit ran without --db, so it read only the migrations and cannot confirm what the live database allows.`,
    fix: {
      text: 'The SQL below, in a new migration, fixes it. Run the audit again with --db to confirm that anon can no longer execute it in the live database.',
      snippet: {
        language: 'sql',
        code: `revoke execute on function ${signature} from public, anon;\n-- Then run the audit with --db: it confirms whether anon can still execute it in the live database.\n`,
      },
    },
    checkBefore: REVOKE_ANON_CHECK,
  };
}
