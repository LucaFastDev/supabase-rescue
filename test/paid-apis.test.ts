import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PAID_APIS, checksUser, paidApiCalls, paidApisCheck } from '../src/checks/paid-apis.ts';
import { paymentsCheck } from '../src/checks/payments.ts';
import type { Finding } from '../src/findings.ts';
import { commitAll, git, gitRepo, tempDir, writeFiles } from './repo.ts';

const run = async (repoPath: string) => paidApisCheck.run({ repoPath, exposedSchemas: ['public'] });
const where = (f: Finding) => ('file' in f.location ? `${f.location.file}:${f.location.line}` : f.location.object);
const summary = (findings: Finding[]) => findings.map((f) => `${f.severity ?? f.kind} ${where(f)}`).sort();

describe('paidApiCalls', () => {
  it.each([
    { name: 'a fetch of the OpenAI host', line: 'fetch("https://api.openai.com/v1/chat/completions", {', api: 'OpenAI' },
    { name: 'an npm: import of openai', line: 'import OpenAI from "npm:openai@4";', api: 'OpenAI' },
    { name: 'a jsr: import of @openai/openai', line: 'import OpenAI from "jsr:@openai/openai";', api: 'OpenAI' },
    { name: 'an esm.sh import of the Anthropic SDK', line: 'import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.1";', api: 'Anthropic' },
    { name: 'a named import of resend', line: 'import { Resend } from "npm:resend@4";', api: 'Resend' },
    { name: 'a require of twilio', line: 'const twilio = require("twilio");', api: 'Twilio' },
    { name: 'a template-literal fetch of the Twilio host', line: 'fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {', api: 'Twilio' },
    { name: 'a dynamic import of a package subpath', line: 'const { Resend } = await import("npm:resend@4/dist");', api: 'Resend' },
  ])('finds $name', ({ line, api }) => {
    expect(paidApiCalls(`const a = 1;\n${line}\n`)).toEqual([{ line: 2, api }]);
  });

  it.each([
    { name: 'a Stripe import', line: 'import Stripe from "npm:stripe@23";' },
    { name: 'a fetch of the Stripe host', line: 'fetch("https://api.stripe.com/v1/charges")' },
    { name: 'a supabase-js import', line: 'import { createClient } from "npm:@supabase/supabase-js@2";' },
    { name: 'a link to the OpenAI docs', line: 'const docs = "https://platform.openai.com/docs";' },
    { name: 'a variable named openai', line: 'const openai = makeClient();' },
    { name: 'a package that only starts with openai', line: 'import x from "npm:openai-edge";' },
    { name: 'a commented-out fetch of OpenAI', line: '// fetch("https://api.openai.com/v1/chat/completions", {' },
    { name: 'a commented-out import of twilio', line: '// import twilio from "npm:twilio@5";' },
  ])('does not find $name', ({ line }) => {
    expect(paidApiCalls(line)).toEqual([]);
  });

  it.each(PAID_APIS.map((api) => ({ name: api.name, host: api.hosts[0]! })))('finds $name by its host $host', ({ name, host }) => {
    expect(paidApiCalls(`await fetch("https://${host}/v1/x");`)).toEqual([{ line: 1, api: name }]);
  });

  it('gives both lines of a text with two calls', () => {
    const src = ['import OpenAI from "npm:openai@4";', 'const x = 1;', 'await fetch("https://api.openai.com/v1/embeddings");'].join('\n');
    expect(paidApiCalls(src)).toEqual([
      { line: 1, api: 'OpenAI' },
      { line: 3, api: 'OpenAI' },
    ]);
  });

  it('gives nothing for a commented-out OpenAI fetch in a block comment', () => {
    expect(paidApiCalls('/*\n * fetch("https://api.openai.com/v1/chat/completions")\n */')).toEqual([]);
  });
});

describe('checksUser', () => {
  it.each([
    'const { data: { user } } = await supabase.auth.getUser();',
    'await supabase.auth.getClaims(token)',
  ])('is true for %s', (line) => {
    expect(checksUser(line)).toBe(true);
  });

  it.each(['const x = 1;', '// await supabase.auth.getUser()', 'const user = getUser();'])('is false for %s', (src) => {
    expect(checksUser(src)).toBe(false);
  });
});

describe('odd texts', () => {
  it.each(['', '\0\0', '}{)(', 'const { = ', 'stripe.prices.create({ amount: [', 'const x = req.body\n'.repeat(3), 'import x from "'])('does not throw on %j', (text) => {
    expect(() => paidApiCalls(text)).not.toThrow();
    expect(() => checksUser(text)).not.toThrow();
  });
});

// The demo's AI summary function, as it is on main: public, no user check, calls OpenAI.
const FETCH_LINE = '  const response = await fetch("https://api.openai.com/v1/chat/completions", {';
const FLAWED_SUMMARY = [
  'Deno.serve(async (req) => {',
  '  const { weeks } = await req.json();',
  FETCH_LINE,
  '    method: "POST",',
  '    headers: { Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}` },',
  '    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: JSON.stringify(weeks) }] }),',
  '  });',
  '  const data = await response.json();',
  '  return Response.json({ summary: data.choices[0].message.content });',
  '});',
].join('\n');

// The same function with the user checked before the paid call: the fixed state.
const FIXED_SUMMARY = [
  'import { createClient } from "npm:@supabase/supabase-js@2";',
  'Deno.serve(async (req) => {',
  '  const { weeks } = await req.json();',
  '  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {',
  '    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },',
  '  });',
  '  const { data: { user } } = await supabase.auth.getUser();',
  '  if (!user) return new Response("Sign in first", { status: 401 });',
  FETCH_LINE,
  '    method: "POST",',
  '  });',
  '  return Response.json({ summary: "x" });',
  '});',
].join('\n');

const PUBLIC_SUMMARY = '[functions.summarise-weeks]\nverify_jwt = false\n';
const lineOf = (src: string, text: string) => src.split('\n').findIndex((l) => l.includes(text)) + 1;

describe('paidApisCheck', () => {
  it("has the id 'h'", () => {
    expect(paidApisCheck.id).toBe('h');
  });

  it('triggers: a public function with no user check that calls OpenAI is one high at the fetch line', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'supabase/config.toml': `[api]\nschemas = ["public"]\n\n${PUBLIC_SUMMARY}`,
      'supabase/functions/summarise-weeks/index.ts': FLAWED_SUMMARY,
    });
    const findings = await run(root);
    expect(summary(findings)).toEqual([`high supabase/functions/summarise-weeks/index.ts:${lineOf(FLAWED_SUMMARY, 'api.openai.com')}`]);
    expect(findings[0]).toMatchObject({
      check: 'h',
      title: 'Anyone can run up your OpenAI bill through the summarise-weeks edge function',
    });
    expect(findings[0]!.why).toContain('line 5');
    expect(findings[0]!.checkBefore).not.toBe('');
  });

  it('triggers through a second file and a package import', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'supabase/config.toml': '[functions.send-sms]\nverify_jwt = false\n',
      'supabase/functions/send-sms/index.ts': 'import "./twilio.ts";\nDeno.serve(() => new Response("ok"));\n',
      'supabase/functions/send-sms/twilio.ts': 'import twilio from "npm:twilio@5";\nexport const client = twilio();\n',
    });
    expect(summary(await run(root))).toEqual(['high supabase/functions/send-sms/twilio.ts:1']);
  });

  it('names every API a public function calls in one finding', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'supabase/config.toml': '[functions.notify]\nverify_jwt = false\n',
      'supabase/functions/notify/index.ts': 'await fetch("https://api.openai.com/v1/chat/completions");\nimport { Resend } from "npm:resend@4";\n',
    });
    const findings = await run(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain('OpenAI and Resend');
    expect(where(findings[0]!)).toBe('supabase/functions/notify/index.ts:1');
  });

  it("does not trigger on the demo's AI summary with sign-in required (the fixed state)", async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'supabase/config.toml': PUBLIC_SUMMARY,
      'supabase/functions/summarise-weeks/index.ts': FIXED_SUMMARY,
    });
    expect(await run(root)).toEqual([]);
  });

  it('does not trigger when verify_jwt is true, or when config.toml has no table for the function', async () => {
    const on = await tempDir();
    await writeFiles(on, {
      'supabase/config.toml': '[functions.summarise-weeks]\nverify_jwt = true\n',
      'supabase/functions/summarise-weeks/index.ts': FLAWED_SUMMARY,
    });
    expect(await run(on)).toEqual([]);
    const absent = await tempDir();
    await writeFiles(absent, {
      'supabase/config.toml': '[api]\nschemas = ["public"]\n',
      'supabase/functions/summarise-weeks/index.ts': FLAWED_SUMMARY,
    });
    expect(await run(absent)).toEqual([]);
  });

  it("does not trigger on the demo's stripe-webhook, which is public on purpose, and check g gives nothing there either", async () => {
    const webhook = await readFile(new URL('../demo/supabase/functions/stripe-webhook/index.ts', import.meta.url), 'utf8');
    const root = await tempDir();
    await writeFiles(root, {
      'supabase/config.toml':
        '[functions.stripe-webhook]\n# Stripe sends no Supabase token; the function checks Stripe\'s signature instead.\nverify_jwt = false\n',
      'supabase/functions/stripe-webhook/index.ts': webhook,
    });
    expect(await run(root)).toEqual([]);
    expect(await paymentsCheck.run({ repoPath: root, exposedSchemas: ['public'] })).toEqual([]);
  });

  it('does not trigger on an OpenAI call outside an edge function', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'supabase/config.toml': PUBLIC_SUMMARY,
      'src/lib/ai.ts': FLAWED_SUMMARY,
    });
    expect(await run(root)).toEqual([]);
  });

  it('does not trigger when a different function is the public one', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'supabase/config.toml': '[functions.other]\nverify_jwt = false\n',
      'supabase/functions/summarise-weeks/index.ts': FLAWED_SUMMARY,
    });
    expect(await run(root)).toEqual([]);
  });

  it('does not trigger for a public function with no folder', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'supabase/config.toml': PUBLIC_SUMMARY });
    expect(await run(root)).toEqual([]);
  });

  it('does not trigger without a supabase/config.toml', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'supabase/functions/summarise-weeks/index.ts': FLAWED_SUMMARY });
    expect(await run(root)).toEqual([]);
  });

  it('in a git repo reads only tracked files: an untracked public function gives nothing, the committed one a high', async () => {
    const root = await gitRepo();
    await writeFiles(root, {
      'README.md': 'x',
      'supabase/config.toml': PUBLIC_SUMMARY,
      'supabase/functions/summarise-weeks/index.ts': FLAWED_SUMMARY,
    });
    git(root, 'add', 'README.md', 'supabase/config.toml');
    git(root, 'commit', '-q', '-m', 'config only');
    expect(await run(root)).toEqual([]);
    commitAll(root, 'track function');
    expect(summary(await run(root))).toEqual([`high supabase/functions/summarise-weeks/index.ts:${lineOf(FLAWED_SUMMARY, 'api.openai.com')}`]);
  });
});
