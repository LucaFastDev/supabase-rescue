// Temporary directories and git repos for the checks' tests, and fake secrets. Every fake secret is
// built at run time by concatenation, so no committed file holds a full secret-shaped string, and
// fixture repos live in a temp directory, never in this repo.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), 'supabase-rescue-fixture-')));
}

/** Writes each file, creating its folders. */
export async function writeFiles(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

/** Stages everything under `root` and commits it; returns the commit's short sha. */
export function commitAll(root: string, message: string): string {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', message);
  return git(root, 'rev-parse', '--short', 'HEAD');
}

export async function gitRepo(): Promise<string> {
  const root = await tempDir();
  git(root, 'init', '-q', '-b', 'main');
  return root;
}

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** n characters of letters and digits, distinct per seed. */
const filler = (seed: string, n: number) => `${seed}Q7x`.repeat(Math.ceil(n / (seed.length + 3))).slice(0, n);

function jwt(role: string, seed: string): string {
  return [b64url({ alg: 'HS256', typ: 'JWT' }), b64url({ iss: 'supabase', ref: 'demo', role }), filler(seed, 43)].join('.');
}

/** A Stripe-shaped live key, distinct per seed. */
export const stripeKey = (seed: string) => 'sk_' + 'live_' + filler(seed, 24);

export const FAKE = {
  serviceRoleJwt: jwt('service' + '_role', 'Jw1'),
  sbSecret: 'sb_' + 'secret_' + filler('Sb2', 32),
  dbPassword: 'Hunter2' + filler('Pw3', 12),
  get dbUrl() {
    return 'postgresql://' + 'postgres:' + this.dbPassword + '@db.example' + '.com';
  },
  stripeLive: stripeKey('St4'),
  stripeTest: 'sk_' + 'test_' + filler('Te5', 24),
  openai: 'sk-' + filler('Oa6', 48),
  openaiProject: 'sk-' + 'proj-' + filler('Op7', 64),
  anthropic: 'sk-' + 'ant-' + 'api03-' + filler('An8', 80),
};

/** Shapes that are never findings. */
export const HARMLESS = {
  anonJwt: jwt('anon', 'An9'),
  sbPublishable: 'sb_' + 'publishable_' + filler('Pb0', 32),
  localDbUrls: [
    'postgresql://' + 'postgres:postgres@127.0.0.1:54322/postgres',
    'postgres://' + 'postgres:postgres@localhost:54322/postgres',
    'postgresql://' + 'postgres:postgres@host.docker.internal:54322/postgres',
  ],
  placeholderDbUrls: [
    'postgresql://' + 'postgres:[YOUR-PASSWORD]@db.example' + '.com:5432/postgres',
    'postgresql://' + 'postgres:${DB_PASSWORD}@db.example' + '.com:5432/postgres',
  ],
};

export const STRIPE_PUBLISHABLE = { test: 'pk_' + 'test_' + filler('Pk1', 24), live: 'pk_' + 'live_' + filler('Pl2', 24) };
