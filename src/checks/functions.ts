// Check c: an exposed function. A SECURITY DEFINER function in an exposed schema that anon can
// execute (directly or through PUBLIC) is critical, one only signed-in users can execute is high.
// A SECURITY DEFINER function in any schema that is not skipped, with no search_path set, is
// medium. A SECURITY INVOKER function in an exposed schema that anon can execute is low. One
// finding per function, at its highest severity, naming every problem it has.

import { catalogFor } from '../catalog.ts';
import type { FunctionRow } from '../catalog.ts';
import { SEVERITIES } from '../findings.ts';
import type { Finding, Severity } from '../findings.ts';
import type { Check } from './index.ts';
import { qualified } from './sql.ts';

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
    if (!catalog) return [];
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

function exposedFunction(fn: FunctionRow, problems: FunctionProblem[]): Finding {
  const name = `${fn.schema}.${fn.name}(${fn.args})`;
  const signature = `${qualified(fn.schema, fn.name)}(${fn.args})`;
  const texts = problems.map((p) => TEXT[p.id]);
  const several = texts.length > 1;
  return {
    check: 'c',
    severity: problems[0]!.severity,
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
