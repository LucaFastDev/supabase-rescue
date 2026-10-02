// Check b: a permissive policy whose expression is just `true`, on a table in an exposed schema.
// Anon writes are critical, writes for signed-in users only are high, anon reads are medium. One
// finding per policy, at its highest severity. RESTRICTIVE policies only narrow access and are
// never findings.

import { catalogFor } from '../catalog.ts';
import type { PolicyRow } from '../catalog.ts';
import type { Finding, Severity } from '../findings.ts';
import type { Check } from './index.ts';
import { ident, qualified } from './sql.ts';

export type Access = 'select' | 'insert' | 'update' | 'delete';
const WRITES: Access[] = ['insert', 'update', 'delete'];

/** True when the expression, trimmed, lower-cased and without outer parentheses, is `true`. */
export function isJustTrue(expression: string | null): boolean {
  if (expression === null) return false;
  let text = expression.trim().toLowerCase();
  while (text.startsWith('(') && closingParen(text) === text.length - 1) text = text.slice(1, -1).trim();
  return text === 'true';
}

/** The index of the parenthesis that closes the one at index 0, or -1. */
function closingParen(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * The kinds of access a policy opens with a `true` expression. INSERT is governed by WITH CHECK,
 * SELECT and DELETE by USING, UPDATE by both; ALL by USING for its reads, updates and deletes and
 * WITH CHECK for its inserts and updates. A null WITH CHECK on UPDATE or ALL means USING.
 */
export function openAccess(policy: Pick<PolicyRow, 'cmd' | 'qual' | 'with_check'>): Access[] {
  const using = isJustTrue(policy.qual);
  const check = isJustTrue(policy.with_check ?? (policy.cmd === 'UPDATE' || policy.cmd === 'ALL' ? policy.qual : null));
  switch (policy.cmd) {
    case 'SELECT':
      return using ? ['select'] : [];
    case 'INSERT':
      return isJustTrue(policy.with_check) ? ['insert'] : [];
    case 'DELETE':
      return using ? ['delete'] : [];
    case 'UPDATE':
      return using || check ? ['update'] : [];
    case 'ALL': {
      const open = new Set<Access>([...(using ? (['select', 'update', 'delete'] as const) : []), ...(check ? (['insert', 'update'] as const) : [])]);
      return (['select', 'insert', 'update', 'delete'] as const).filter((a) => open.has(a));
    }
  }
}

export interface PolicyProblem {
  severity: Severity;
  /** Who the policy lets in: anyone (anon) or any signed-in user. */
  who: 'anon' | 'authenticated';
  access: Access[];
}

/** The policy's problem at its highest severity, or undefined when it has none. */
export function policyProblem(policy: PolicyRow): PolicyProblem | undefined {
  if (policy.permissive !== 'PERMISSIVE') return undefined;
  const anon = policy.roles.includes('anon') || policy.roles.includes('public');
  const authenticated = policy.roles.includes('authenticated') || policy.roles.includes('public');
  const open = openAccess(policy);
  const writes = open.filter((a) => WRITES.includes(a));
  if (anon && writes.length > 0) return { severity: 'critical', who: 'anon', access: open };
  if (authenticated && writes.length > 0) return { severity: 'high', who: 'authenticated', access: writes };
  if (anon && open.includes('select')) return { severity: 'medium', who: 'anon', access: ['select'] };
  return undefined;
}

export const policiesCheck: Check = {
  id: 'b',
  async run(context) {
    const catalog = catalogFor(context);
    if (!catalog) return [];
    const findings: Finding[] = [];
    for (const policy of (await catalog).policies) {
      const problem = policyProblem(policy);
      if (problem) findings.push(permissivePolicy(policy, problem));
    }
    return findings;
  },
};

const VERB: Record<Access, string> = {
  select: 'read every row',
  insert: 'add any row',
  update: 'change any row',
  delete: 'delete any row',
};

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function permissivePolicy(policy: PolicyRow, problem: PolicyProblem): Finding {
  const table = `${policy.schema}.${policy.table}`;
  const name = `${table} policy "${policy.name}"`;
  const anyone = problem.who === 'anon';
  const whoText = anyone ? 'anyone who has your anon key, which ships inside your app to every visitor,' : 'any signed-in user';
  const actions = list(problem.access.map((a) => VERB[a]));
  const title =
    problem.severity === 'medium'
      ? `Policy "${policy.name}" lets anyone read every row of ${table}`
      : `Policy "${policy.name}" lets ${anyone ? 'anyone' : 'any signed-in user'} ${actions} in ${table}`;
  const roles = policy.roles.join(', ');

  const why =
    `The policy applies to ${roles} for ${policy.cmd}, and its condition is just \`true\`, so it allows every row: ${whoText} can ${actions} in this table through the Data API.` +
    (problem.severity === 'medium'
      ? ' That is right only if every row and every column of the table is meant to be public.'
      : '');

  const fixText =
    problem.severity === 'medium'
      ? 'Decide whether this data is meant to be public: would you be happy to see every row and every column of this table on your public website? Things like a list of services or opening hours usually are. Names, emails, phone numbers, notes or anything about a single customer are not. If it is public, keep the policy and note that it is intentional. If not, replace `true` with a condition, for example limiting the policy to signed-in users and the rows that belong to them.'
      : "Replace `true` with a condition that says whose rows these are, and limit the policy to the roles that need it. The example limits it to signed-in users and the rows they own; replace user_id with the column that holds a row's owner.";

  return {
    check: 'b',
    severity: problem.severity,
    title,
    location: { object: name },
    why,
    fix: { text: fixText, snippet: { language: 'sql', code: alterPolicy(policy) } },
    checkBefore:
      problem.severity === 'medium'
        ? 'Which pages read this table before sign-in: if you restrict the policy, they will see no rows. Also check the column you compare with auth.uid() exists and is filled on every row.'
        : 'Which parts of the app use this table, and as whom: after the change, anything that relied on the open policy, such as a sign-up or booking form for visitors, gets an error or no rows. Check the column you compare with auth.uid() exists and is filled on every row.',
  };
}

function alterPolicy(policy: PolicyRow): string {
  const owner = '((select auth.uid()) = user_id)';
  const clauses: string[] = [];
  if (policy.cmd !== 'INSERT') clauses.push(`using ${owner}`);
  if (policy.cmd !== 'SELECT' && policy.cmd !== 'DELETE') clauses.push(`with check ${owner}`);
  return [
    `alter policy ${ident(policy.name)} on ${qualified(policy.schema, policy.table)}`,
    '  to authenticated',
    ...clauses.map((c, i) => `  ${c}${i === clauses.length - 1 ? ';' : ''}`),
    '',
  ].join('\n');
}
