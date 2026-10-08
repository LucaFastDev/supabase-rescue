// Check d: a secret in the repo. Scans the files git tracks under the audited path (every file,
// when the path is not in a git repo), and the git history of that path only, for keys that were
// committed and later deleted. A secret is never printed: findings show it masked.

import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { walkFiles } from '../files.ts';
import type { Finding } from '../findings.ts';
import type { Check } from './index.ts';

const execFileAsync = promisify(execFile);

/** Files over this size are skipped. */
const MAX_FILE_BYTES = 1024 * 1024;
/** git's own binary heuristic: a NUL byte in the first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;
/** git log of a long history can be large; past this the audit stops with an error. */
const MAX_GIT_OUTPUT = 256 * 1024 * 1024;

export type SecretKind = 'service-role-jwt' | 'sb-secret' | 'postgres-url' | 'stripe' | 'openai' | 'anthropic';

export interface Secret {
  kind: SecretKind;
  /** The secret as found. Never put into a finding: use mask(). */
  value: string;
}

interface Pattern {
  kind: SecretKind;
  re: RegExp;
  /** Further test on a match, for what a regular expression cannot say. */
  accept?: (match: RegExpMatchArray) => boolean;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', 'host.docker.internal']);

const PATTERNS: Pattern[] = [
  // A JWT whose decoded payload has "role":"service_role". The anon key is the same shape with
  // "role":"anon", and is never a finding.
  { kind: 'service-role-jwt', re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, accept: (m) => jwtRole(m[0]) === 'service_role' },
  // sb_secret_ keys. sb_publishable_ keys are meant for the browser and never match.
  { kind: 'sb-secret', re: /\bsb_secret_[A-Za-z0-9_-]{16,}/g },
  // postgres:// or postgresql:// with user:password@host, where the password is not empty, is not
  // a placeholder such as [YOUR-PASSWORD], <password> or ${DB_PASSWORD}, and the host is not local.
  // The whole URL up to the host is the secret, so its masked form never shows the password.
  {
    kind: 'postgres-url',
    re: /\bpostgres(?:ql)?:\/\/[^\s:@/'"`]+:([^\s@/'"`]+)@([^\s/:?#'"`]+)/g,
    accept: (m) => !/^[$[<{%]/.test(m[1]!) && !LOCAL_HOSTS.has(m[2]!.toLowerCase()),
  },
  // Stripe secret keys, live and test.
  { kind: 'stripe', re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g },
  // Anthropic keys: sk-ant-…
  { kind: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{32,}/g },
  // OpenAI keys: sk-… and sk-proj-…, but not sk-ant-. At least 32 characters after sk- and at least
  // one digit, so a kebab-case name that happens to start with sk- is not mistaken for a key.
  { kind: 'openai', re: /\bsk-(?!ant-)[A-Za-z0-9_-]{32,}/g, accept: (m) => /\d/.test(m[0]) },
];

/** Every secret on one line of text, in the order the patterns are listed. */
export function findSecrets(line: string): Secret[] {
  const found: Secret[] = [];
  for (const { kind, re, accept } of PATTERNS) {
    for (const match of line.matchAll(re)) {
      if (!accept || accept(match)) found.push({ kind, value: match[0] });
    }
  }
  return found;
}

/** The secret's first 6 and last 4 characters, with … between. */
export function mask(secret: string): string {
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

function jwtRole(token: string): unknown {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).role : undefined;
  } catch {
    // Not a JWT after all: its payload is not base64url-encoded JSON.
    return undefined;
  }
}

const KIND_TEXT: Record<SecretKind, { label: string; impact: string; rotate: string }> = {
  'service-role-jwt': {
    label: 'Supabase service-role key',
    impact: 'It bypasses every row level security policy: whoever holds it can read, change and delete every row in the database.',
    rotate:
      'In the Supabase dashboard, Project Settings, API Keys: move to the new publishable and secret keys and disable the legacy JWT-based keys, or roll the JWT secret (which replaces the anon key too).',
  },
  'sb-secret': {
    label: 'Supabase secret key',
    impact: 'It bypasses every row level security policy: whoever holds it can read, change and delete every row in the database.',
    rotate: 'In the Supabase dashboard, Project Settings, API Keys: create a new secret key, move every server that uses this one over to it, then delete this one.',
  },
  'postgres-url': {
    label: 'Database password',
    impact: 'It is a direct login to the database, past the API and its row level security policies.',
    rotate: 'In the Supabase dashboard, Project Settings, Database: reset the database password.',
  },
  stripe: {
    label: 'Stripe secret key',
    impact: "It can create charges, issue refunds and read your customers' payment details.",
    rotate: 'In the Stripe Dashboard, Developers, API keys: roll the key.',
  },
  openai: {
    label: 'OpenAI API key',
    impact: 'Anyone holding it can run requests billed to your account.',
    rotate: 'In the OpenAI platform, API keys: revoke the key and create a new one.',
  },
  anthropic: {
    label: 'Anthropic API key',
    impact: 'Anyone holding it can run requests billed to your account.',
    rotate: 'In the Claude Console, API keys: disable the key and create a new one.',
  },
};

const CHECK_BEFORE =
  'Every place that uses this key (servers, edge functions, CI, local env files), so you can give them the new one before the old one stops working.';

// Frontend: these top-level folders of the audited root, and index.html. Never supabase/.
const FRONTEND_DIRS = ['src/', 'public/', 'app/', 'pages/', 'components/'];
// A variable the browser build inlines, assigned in a .env* file.
const PUBLIC_ENV_ASSIGNMENT = /^\s*(?:export\s+)?((VITE|NEXT_PUBLIC|EXPO_PUBLIC)_\w*)\s*=/;

function isFrontend(file: string): boolean {
  return file === 'index.html' || FRONTEND_DIRS.some((dir) => file.startsWith(dir));
}

function isEnvFile(file: string): boolean {
  return path.posix.basename(file).startsWith('.env');
}

/** Where a current-file secret ships to the browser, if it does. */
function browserExposure(file: string, line: string): string | undefined {
  if (isEnvFile(file)) {
    const match = PUBLIC_ENV_ASSIGNMENT.exec(line);
    if (match) return `${file} sets ${match[1]}, and the build puts every ${match[2]}_ variable into the code each visitor downloads, so anyone who opens the app can read this key.`;
  }
  if (isFrontend(file)) return `${file} is frontend code, which ships to every visitor's browser, so anyone who opens the app can read this key.`;
  return undefined;
}

interface Occurrence {
  secret: Secret;
  line: number;
  /** Why it is critical, when it is: the first line that ships it to the browser. */
  exposure?: string;
}

/** One occurrence per distinct secret in a file's text: its first line, critical if any line is. */
export function scanText(file: string, text: string): Occurrence[] {
  const bySecret = new Map<string, Occurrence>();
  text.split('\n').forEach((line, i) => {
    for (const secret of findSecrets(line)) {
      const exposure = browserExposure(file, line);
      const seen = bySecret.get(secret.value);
      if (!seen) bySecret.set(secret.value, { secret, line: i + 1, ...(exposure && { exposure }) });
      else if (!seen.exposure && exposure) seen.exposure = exposure;
    }
  });
  return [...bySecret.values()];
}

export async function git(cwd: string, args: string[]): Promise<string> {
  // LC_ALL=C keeps git's messages in English, so inGitRepo can read them.
  const env = { ...process.env, LC_ALL: 'C' };
  const { stdout } = await execFileAsync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT });
  return stdout;
}

/** True when `cwd` is inside a git work tree. Throws when git cannot answer. */
export async function inGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch (error) {
    // Only "not a git repository" means scan every file. Anything else, such as git not being
    // installed or refusing a repo owned by another user, would silently skip the history, so the
    // audit stops instead.
    if (/not a git repository/i.test(String((error as { stderr?: unknown }).stderr ?? ''))) return false;
    throw error;
  }
}

/** The text of a file worth scanning, or undefined when it is not a regular file, too big or binary. */
export async function readScannable(full: string): Promise<string | undefined> {
  const info = await lstat(full).catch((error: NodeJS.ErrnoException) => {
    // Tracked but deleted from the working tree.
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info?.isFile() || info.size > MAX_FILE_BYTES) return undefined;
  const bytes = await readFile(full);
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
  return bytes.toString('utf8');
}

interface HistoryHit {
  secret: Secret;
  sha: string;
  file: string;
  line: number;
}

/**
 * Secrets in added lines of the audited path's history: `git log --all -p` limited to that path,
 * with paths relative to it. Keyed by secret; each keeps its oldest commit, since git log lists
 * the newest first.
 */
async function scanHistory(repoPath: string): Promise<Map<string, HistoryHit>> {
  const log = await git(repoPath, [
    '-c', 'core.quotePath=false',
    '-c', 'log.showSignature=false',
    'log', '--all', '-p', '--relative', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', '--format=%x00%h',
    '--', '.',
  ]);

  const hits = new Map<string, HistoryHit>();
  let sha = '';
  let file: string | undefined;
  let inHunk = false;
  let newLine = 0;
  for (const line of log.split('\n')) {
    if (line.startsWith('\0')) {
      sha = line.slice(1);
      file = undefined;
      inHunk = false;
    } else if (line.startsWith('diff --git ')) {
      file = undefined;
      inHunk = false;
    } else if (line.startsWith('@@')) {
      const start = /^@@+ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      inHunk = start !== null;
      newLine = start ? Number(start[1]) : 0;
    } else if (!inHunk) {
      if (line.startsWith('+++ ')) file = diffPath(line.slice(4));
    } else if (line.startsWith('+')) {
      if (file !== undefined) {
        for (const secret of findSecrets(line.slice(1))) hits.set(secret.value, { secret, sha, file, line: newLine });
      }
      newLine++;
    } else if (line.startsWith(' ')) {
      newLine++;
    }
  }
  return hits;
}

/** The path in a `+++ b/<path>` header; undefined for /dev/null. Unquotes git's C-quoted form. */
function diffPath(header: string): string | undefined {
  const unquoted = header.startsWith('"') && header.endsWith('"') ? header.slice(1, -1).replace(/\\(.)/g, '$1') : header;
  return unquoted.startsWith('b/') ? unquoted.slice(2) : undefined;
}

function currentFinding(file: string, { secret, line, exposure }: Occurrence): Finding {
  const { label, impact, rotate } = KIND_TEXT[secret.kind];
  const where = exposure ? (isEnvFile(file) ? 'in a browser-exposed env variable' : 'in code that ships to the browser') : 'in a committed file';
  return {
    check: 'd',
    severity: exposure ? 'critical' : 'high',
    owner: exposure
      ? "A secret key ships to every visitor's browser, so anyone can use it."
      : 'A secret key is saved in your code repository.',
    title: `${label} ${mask(secret.value)} ${where}`,
    location: { file, line },
    why: `${exposure ?? 'Anyone who can read this repository, or any copy of it, has this key.'} ${impact}`,
    fix: {
      text: `Rotate the key first. ${rotate} Then remove it from ${file} and keep it only in server-side secrets (an edge function secret, or your host's environment variables), never in a variable the browser build reads. Deleting the line is not enough: the git history keeps the old key.`,
    },
    checkBefore: CHECK_BEFORE,
  };
}

function historyFinding({ secret, sha, file, line }: HistoryHit): Finding {
  const { label, rotate } = KIND_TEXT[secret.kind];
  return {
    check: 'd',
    kind: 'manual',
    title: `Rotate the ${label} ${mask(secret.value)} found in the git history`,
    location: { file, line },
    why: `Rotate this key: it is in the git history at ${sha} ${file}, and the history keeps it after any fix; the tool cannot see whether you rotated it.`,
    fix: { text: `${rotate} Rewriting the history does not help: every clone and fork already has the key.` },
    checkBefore: CHECK_BEFORE,
  };
}

export const secretsCheck: Check = {
  id: 'd',
  async run({ repoPath }) {
    const repo = await inGitRepo(repoPath);
    const files = repo
      ? (await git(repoPath, ['-c', 'core.quotePath=false', 'ls-files', '-z'])).split('\0').filter(Boolean).sort()
      : await walkFiles(repoPath);

    const findings: Finding[] = [];
    const current = new Set<string>();
    for (const file of files) {
      const text = await readScannable(path.join(repoPath, file));
      if (text === undefined) continue;
      for (const occurrence of scanText(file, text)) {
        current.add(occurrence.secret.value);
        findings.push(currentFinding(file, occurrence));
      }
    }

    if (repo) {
      for (const [value, hit] of await scanHistory(repoPath)) {
        if (!current.has(value)) findings.push(historyFinding(hit));
      }
    }
    return findings;
  },
};
