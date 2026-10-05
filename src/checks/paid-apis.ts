// Check h: paid APIs anyone can run up. Reads only the repo, never the database, and reports one
// thing: an edge function that supabase/config.toml makes callable without sign-in
// (verify_jwt = false), that checks no signed-in user itself, and whose code calls a known paid API
// (AI, email or SMS providers): high.
//
// Like checks d to g this is a line scanner over source text, not a parser: it looks only at the
// files in the function's own folder, and does not follow imports out of it. A case it misses is
// acceptable; a crash on odd source text is not.

import path from 'node:path';
import { readConfig } from '../config.ts';
import { walkFiles } from '../files.ts';
import type { Finding } from '../findings.ts';
import type { Check } from './index.ts';
import { withoutComments } from './payments.ts';
import { git, inGitRepo, readScannable } from './secrets.ts';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface PaidApi {
  name: string;
  hosts: string[];
  packages: string[];
}

/** The paid APIs a Lovable app commonly calls, matched by API host or SDK package. */
export const PAID_APIS: PaidApi[] = [
  { name: 'OpenAI', hosts: ['api.openai.com'], packages: ['openai', '@openai/openai'] },
  { name: 'Anthropic', hosts: ['api.anthropic.com'], packages: ['@anthropic-ai/sdk'] },
  {
    name: 'Google Gemini',
    hosts: ['generativelanguage.googleapis.com'],
    packages: ['@google/genai', '@google/generative-ai'],
  },
  { name: 'Mistral', hosts: ['api.mistral.ai'], packages: ['@mistralai/mistralai'] },
  { name: 'Lovable AI', hosts: ['ai.gateway.lovable.dev'], packages: [] },
  { name: 'Replicate', hosts: ['api.replicate.com'], packages: ['replicate'] },
  { name: 'ElevenLabs', hosts: ['api.elevenlabs.io'], packages: ['elevenlabs', '@elevenlabs/elevenlabs-js'] },
  { name: 'Voyage AI', hosts: ['api.voyageai.com'], packages: ['voyageai'] },
  { name: 'Resend', hosts: ['api.resend.com'], packages: ['resend'] },
  { name: 'SendGrid', hosts: ['api.sendgrid.com'], packages: ['@sendgrid/mail'] },
  { name: 'Twilio', hosts: ['api.twilio.com'], packages: ['twilio'] },
];

const MATCHERS = PAID_APIS.map((api) => {
  const hosts = api.hosts.map((host) => `(?<![\\w.-])${escapeRegExp(host)}(?![\\w-])`);
  const packages = api.packages.map(
    (pkg) =>
      `(?:\\bfrom|\\bimport\\s*\\(|\\brequire\\s*\\()\\s*['"\`](?:npm:|jsr:|https:\\/\\/esm\\.sh\\/)?${escapeRegExp(pkg)}(?:@[^'"\`\\/]+)?(?:\\/[^'"\`]*)?['"\`]`,
  );
  return { name: api.name, pattern: new RegExp([...hosts, ...packages].join('|')) };
});

const USER_CHECK = /\bauth\s*\.\s*(?:getUser|getClaims)\s*\(/;

/** Every 1-based line that names a paid API, with the name of the first one it matches. */
export function paidApiCalls(src: string): { line: number; api: string }[] {
  const calls: { line: number; api: string }[] = [];
  withoutComments(src).forEach((text, i) => {
    const match = MATCHERS.find((matcher) => matcher.pattern.test(text));
    if (match) calls.push({ line: i + 1, api: match.name });
  });
  return calls;
}

/** True when the code reads the signed-in user: auth.getUser( or auth.getClaims(. */
export function checksUser(src: string): boolean {
  return withoutComments(src).some((line) => USER_CHECK.test(line));
}

const SNIPPET = `import { createClient } from "npm:@supabase/supabase-js@2";

// Before any paid call: who is asking? The anon key alone is a valid token, so check the user.
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
  global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
});
const { data: { user } } = await supabase.auth.getUser();
if (!user) {
  return new Response("Sign in first", { status: 401 });
}`;

function finding(name: string, configLine: number, file: string, line: number, apis: string): Finding {
  return {
    check: 'h',
    severity: 'high',
    title: `Anyone can run up your ${apis} bill through the ${name} edge function`,
    location: { file, line },
    why: `supabase/config.toml line ${configLine} sets verify_jwt = false for ${name}, and the function checks no signed-in user, so it runs for any request from anyone. This line calls ${apis}, which bills your account for every call. Anyone who finds the function's address, which the app's own code shows, can call it in a loop and run up the bill, or use up your quota so the feature stops working for your users.`,
    fix: {
      text: `Make the function refuse anyone who is not signed in: before the paid call, read the user from the request's Authorization header with supabase.auth.getUser() and answer 401 when there is none. Turning verify_jwt back on is not enough by itself, because the public anon key is itself a valid token. If the function must stay public, put a rate limit in front of the paid call instead, and set a monthly spending limit with ${apis}.`,
      snippet: { language: 'ts', code: SNIPPET },
    },
    checkBefore: `Whether ${name} is meant for visitors who are not signed in, such as a contact form or a public chatbot. If it is, and a rate limit or a spending cap already guards it elsewhere (a limit in front of the function, or a hard monthly limit set with ${apis}), this finding does not apply; if nothing limits it, add a rate limit rather than sign-in. Otherwise, find every page that calls ${name}: after the fix it works only for a signed-in user, which supabase.functions.invoke handles by sending the user's session.`,
  };
}

export const paidApisCheck: Check = {
  id: 'h',
  async run({ repoPath }) {
    const config = await readConfig(repoPath);
    if (!config?.publicFunctions) return [];

    // The same files as check g: what git tracks under the path, or every file outside a repo.
    const repo = await inGitRepo(repoPath);
    const files = repo
      ? (await git(repoPath, ['-c', 'core.quotePath=false', 'ls-files', '-z'])).split('\0').filter(Boolean).sort()
      : await walkFiles(repoPath);

    const findings: Finding[] = [];
    for (const { name, line: configLine } of config.publicFunctions) {
      const folder = `supabase/functions/${name}/`;
      const sources = files.filter((f) => f.startsWith(folder) && SOURCE_EXTENSIONS.has(path.posix.extname(f)));

      const calls: { file: string; line: number; api: string }[] = [];
      let signsIn = false;
      for (const file of sources) {
        const text = await readScannable(path.join(repoPath, file));
        if (text === undefined) continue;
        if (checksUser(text)) signsIn = true;
        for (const call of paidApiCalls(text)) calls.push({ file, ...call });
      }
      if (calls.length === 0 || signsIn) continue;

      const apis = [...new Set(calls.map((call) => call.api))].join(' and ');
      findings.push(finding(name, configLine, calls[0]!.file, calls[0]!.line, apis));
    }
    return findings;
  },
};
