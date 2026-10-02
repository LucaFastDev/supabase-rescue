// Check e: auth gaps. Email confirmation off in config.toml; React Router routes that render data
// without an auth check (a review entry: a static read cannot be certain); and the live project's
// auth settings, which cannot be read without the Management API, as manual checks.
//
// The route reading is a light scanner, not a parser. It skips strings and comments, balances
// brackets, and gives up on a structure it cannot balance. A missed route is acceptable; a crash on
// an odd file is not.

import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE, readConfig } from '../config.ts';
import { walkFiles } from '../files.ts';
import type { Finding } from '../findings.ts';
import type { Check } from './index.ts';

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
const MAX_FILE_BYTES = 1024 * 1024;

/** A component that guards what it wraps. */
const GUARD = /^(Protected|Private|Require|Auth|Authenticated)\w*/;
/** A component file that checks the session itself. */
const AUTH_CALL = /\bauth\s*\.\s*(getUser|getSession)\b|\b(useAuth|useSession|useUser)\b/;

export const authCheck: Check = {
  id: 'e',
  async run({ repoPath }) {
    const findings: Finding[] = [];
    const confirmations = (await readConfig(repoPath))?.enableConfirmations;
    if (confirmations?.value === false) findings.push(confirmationsOff(confirmations.line));
    findings.push(...(await unguardedRoutes(repoPath)));
    findings.push(...MANUAL_CHECKS);
    return findings;
  },
};

function confirmationsOff(line: number): Finding {
  return {
    check: 'e',
    severity: 'medium',
    title: 'Email confirmation is off in config.toml',
    location: { file: CONFIG_FILE, line },
    why: 'enable_confirmations = false lets anyone sign up with an email address they do not own and use the account at once. This file configures the local stack and can be pushed to the live project with supabase config push, so it is often what production runs with too.',
    fix: {
      text: 'Turn confirmations on, here and in the dashboard (see the manual check "Confirm email is on").',
      snippet: { language: 'toml', code: '[auth.email]\nenable_confirmations = true\n' },
    },
    checkBefore: 'That your sign-up flow tells users to check their inbox before signing in. Users who signed up while it was off stay confirmed.',
  };
}

const PROVIDERS_EMAIL = 'Supabase dashboard: Authentication > Sign In / Providers > Email';
const ATTACK_PROTECTION = 'Supabase dashboard: Authentication > Attack Protection';
const NOT_READABLE = "The tool cannot read the live project's auth settings without the Management API, which it never uses.";

export const MANUAL_CHECKS: Finding[] = [
  {
    check: 'e',
    kind: 'manual',
    title: 'Confirm email is on',
    location: { object: PROVIDERS_EMAIL },
    why: `Without email confirmation, anyone can sign up with an address they do not own, and the account works at once. ${NOT_READABLE}`,
    fix: { text: 'In the Supabase dashboard, Authentication, Sign In / Providers, Email: turn on Confirm email.' },
    checkBefore: 'That your sign-up flow tells users to check their inbox, and that the link in the email goes to an allowed redirect URL.',
  },
  {
    check: 'e',
    kind: 'manual',
    title: 'Secure email change is on',
    location: { object: PROVIDERS_EMAIL },
    why: `Without it, a new email address needs confirming only from the new address, so someone with brief access to a signed-in session can move the account to an inbox they control. ${NOT_READABLE}`,
    fix: { text: 'In the Supabase dashboard, Authentication, Sign In / Providers, Email: turn on Secure email change.' },
    checkBefore: 'How users who can no longer reach their old inbox will change their address: they will need your support.',
  },
  {
    check: 'e',
    kind: 'manual',
    title: 'Leaked password protection is on',
    location: { object: ATTACK_PROTECTION },
    why: `It refuses passwords known from public data breaches, which are the first ones attackers try. ${NOT_READABLE}`,
    fix: { text: 'In the Supabase dashboard, Authentication, Attack Protection: turn on leaked password protection.' },
    checkBefore: 'That your sign-up and password-reset forms show the error the API returns when a password is refused.',
  },
  {
    check: 'e',
    kind: 'manual',
    title: 'Minimum password length is at least 8',
    location: { object: ATTACK_PROTECTION },
    why: `Short passwords fall to guessing quickly. ${NOT_READABLE}`,
    fix: { text: 'In the Supabase dashboard, Authentication, Attack Protection: set the minimum password length to 8 or more.' },
    checkBefore: "That your sign-up form's own validation and message match the new minimum. Existing passwords keep working.",
  },
  {
    check: 'e',
    kind: 'manual',
    title: "Site URL and redirect URLs list only the app's own domains",
    location: { object: 'Supabase dashboard: Authentication > URL Configuration' },
    why: `Sign-in links, password resets and OAuth sign-ins send users, with their session, to these URLs. A broad wildcard or a domain you do not control lets someone else receive a session. ${NOT_READABLE}`,
    fix: {
      text: "In the Supabase dashboard, Authentication, URL Configuration: set Site URL to the app's production address, and list in Redirect URLs only the app's own domains (and localhost while developing), without broad wildcards.",
    },
    checkBefore: 'Every redirectTo and emailRedirectTo your app passes, so each one is still on the list.',
  },
];

// ---- Routes ----------------------------------------------------------------------------------

interface Route {
  file: string;
  line: number;
  path: string;
  element: string;
  /** The route or an ancestor route wraps its element in a guard component. */
  guarded: boolean;
}

async function unguardedRoutes(repoPath: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const files = (await walkFiles(repoPath, path.join(repoPath, 'src'))).filter((f) =>
    SOURCE_EXTENSIONS.includes(path.posix.extname(f)),
  );
  for (const file of files) {
    const src = await readSource(path.join(repoPath, file));
    if (src === undefined) continue;
    const routes = [...jsxRoutes(file, src), ...objectRoutes(file, src)];
    if (routes.length === 0) continue;
    const imports = importsOf(src);
    for (const route of routes) {
      if (route.guarded) continue;
      const page = await dataComponentWithoutAuth(repoPath, path.join(repoPath, file), route.element, imports);
      if (page) findings.push(unguardedRoute(route, page));
    }
  }
  return findings;
}

async function readSource(full: string): Promise<string | undefined> {
  const info = await lstat(full).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info?.isFile() || info.size > MAX_FILE_BYTES) return undefined;
  return readFile(full, 'utf8');
}

function unguardedRoute(route: Route, page: string): Finding {
  return {
    check: 'e',
    kind: 'review',
    title: `Route ${route.path} renders data without an auth check`,
    location: { file: route.file, line: route.line },
    why: `The page at ${route.path} (${page}) reads from the database, and neither the route nor the page checks that the visitor is signed in. Whether that data reaches visitors who are not signed in depends on the tables' RLS policies, which a static read cannot see, and the page may be meant to be public.`,
    fix: {
      text: 'If the page is for signed-in users, wrap the route in a component that sends everyone else to the sign-in page, and make sure the RLS policies on the tables it reads allow only the users who should see the rows.',
      snippet: {
        language: 'tsx',
        code: [
          'function RequireAuth({ children }: { children: JSX.Element }) {',
          '  const [session, setSession] = useState<Session | null | undefined>(undefined);',
          '  useEffect(() => {',
          '    supabase.auth.getSession().then(({ data }) => setSession(data.session));',
          '  }, []);',
          '  if (session === undefined) return null;',
          '  return session ? children : <Navigate to="/login" replace />;',
          '}',
          '',
          `<Route path="${route.path}" element={<RequireAuth><Page /></RequireAuth>} />`,
          '',
        ].join('\n'),
      },
    },
    checkBefore: 'Whether this page is meant to be public. A route guard only hides the page: the data itself is protected by the RLS policies on the tables it reads, so check those too.',
  };
}

/**
 * The first component in the element that resolves through a relative or `@/` import to a file calling
 * `.from(` or `.rpc(`, with no auth call in that file, as a path relative to the audited root.
 */
async function dataComponentWithoutAuth(
  repoPath: string,
  routeFile: string,
  element: string,
  imports: Map<string, string>,
): Promise<string | undefined> {
  for (const name of componentNames(element)) {
    if (GUARD.test(name)) continue;
    const specifier = imports.get(name);
    if (!specifier) continue;
    const resolved = await resolveImport(repoPath, routeFile, specifier);
    if (!resolved) continue;
    const src = await readSource(resolved);
    if (src !== undefined && callsData(src) && !AUTH_CALL.test(src)) {
      return path.relative(repoPath, resolved).split(path.sep).join('/');
    }
  }
  return undefined;
}

/** The JSX tag names in an element expression. */
function componentNames(element: string): string[] {
  return [...element.matchAll(/<([A-Za-z_$][\w$.]*)/g)].map((m) => m[1]!).filter((n) => /^[A-Z]/.test(n));
}

function hasGuard(element: string): boolean {
  return componentNames(element).some((name) => GUARD.test(name));
}

/**
 * True when the file calls `.from(` or `.rpc(`, as supabase-js queries do. A call on a name that
 * starts with a capital, such as Array.from( or Buffer.from(, is not a query and does not count.
 */
export function callsData(src: string): boolean {
  for (const match of src.matchAll(/\.\s*(?:from|rpc)\s*\(/g)) {
    const receiver = /[\w$]*$/.exec(src.slice(Math.max(0, match.index - 64), match.index))![0];
    if (!/^[A-Z]/.test(receiver)) return true;
  }
  return false;
}

/** The `@/` alias of Vite, shadcn/ui and Lovable projects: `@/x` is `<audited root>/src/x`. */
const SRC_ALIAS = '@/';

/**
 * Local name → module specifier, for default, named and React.lazy imports of relative paths and
 * of the `@/` alias.
 */
export function importsOf(src: string): Map<string, string> {
  const imports = new Map<string, string>();
  const inRepo = (spec: string) => spec.startsWith('./') || spec.startsWith('../') || spec.startsWith(SRC_ALIAS);
  for (const [, clause, spec] of src.matchAll(/\bimport\s+(?!type\b)([\w$\s{},*]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (!inRepo(spec!)) continue;
    const defaultName = /^\s*([A-Za-z_$][\w$]*)/.exec(clause!)?.[1];
    if (defaultName) imports.set(defaultName, spec!);
    for (const named of /\{([^}]*)\}/.exec(clause!)?.[1]?.split(',') ?? []) {
      const local = /([A-Za-z_$][\w$]*)\s*$/.exec(named.trim())?.[1];
      if (local && !/^type\s/.test(named.trim())) imports.set(local, spec!);
    }
  }
  const lazy = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.)?lazy\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const [, name, spec] of src.matchAll(lazy)) {
    if (inRepo(spec!)) imports.set(name!, spec!);
  }
  return imports;
}

/**
 * The file a relative or `@/` import names, trying each source extension and index file; inside
 * the audited root only.
 */
async function resolveImport(repoPath: string, fromFile: string, specifier: string): Promise<string | undefined> {
  const base = specifier.startsWith(SRC_ALIAS)
    ? path.resolve(repoPath, 'src', specifier.slice(SRC_ALIAS.length))
    : path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    ...(SOURCE_EXTENSIONS.includes(path.extname(base)) ? [base] : []),
    ...SOURCE_EXTENSIONS.map((ext) => base + ext),
    ...SOURCE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    if (path.relative(repoPath, candidate).startsWith('..')) continue;
    const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      // No such file, or a file where the path expects a folder: try the next candidate.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    });
    if (info?.isFile()) return candidate;
  }
  return undefined;
}

// ---- The scanner -----------------------------------------------------------------------------

const OPENERS = '([{';
const CLOSERS = ')]}';

/**
 * The index just past the string, template literal or comment that starts at `i`, or `i` itself
 * when none does. A quoted string ends at its line's end at the latest, so an apostrophe in JSX
 * text costs at most the rest of that line.
 */
function skipNonCode(src: string, i: number): number {
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
    return Math.min(j + 1, src.length);
  }
  if (c === '/' && src[i + 1] === '/') {
    const end = src.indexOf('\n', i);
    return end === -1 ? src.length : end;
  }
  if (c === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end === -1 ? src.length : end + 2;
  }
  return i;
}

/** The index of the bracket that closes the one at `open`, or -1 when it never closes. */
function findClose(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; ) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = src[i]!;
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c) && --depth === 0) return i;
    i++;
  }
  return -1;
}

function lineAt(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (src[i] === '\n') line++;
  return line;
}

/** A path value without its quotes or braces. */
function pathText(raw: string): string {
  const trimmed = raw.trim();
  return /^(['"`])(.*)\1$/s.exec(trimmed)?.[2] ?? trimmed;
}

/** `<Route …>` tags, with nesting from matching `</Route>`. */
function jsxRoutes(file: string, src: string): Route[] {
  const routes: Route[] = [];
  const open: boolean[] = []; // guarded, per enclosing open <Route>
  let cursor = 0;
  for (const match of src.matchAll(/<Route(?=[\s/>])|<\/Route\s*>/g)) {
    if (match.index < cursor) continue;
    if (match[0].startsWith('</')) {
      open.pop();
      continue;
    }
    const tag = parseTag(src, match.index + '<Route'.length);
    if (!tag) continue;
    cursor = tag.end;
    const element = tag.attrs.get('element') ?? '';
    const guarded = (open.at(-1) ?? false) || hasGuard(element);
    const routePath = tag.attrs.get('path');
    if (routePath !== undefined && tag.attrs.has('element')) {
      routes.push({ file, line: lineAt(src, match.index), path: pathText(routePath), element, guarded });
    }
    if (!tag.selfClosing) open.push(guarded);
  }
  return routes;
}

/** A JSX tag's attributes, read from just after its name up to its `>` or `/>`. */
function parseTag(src: string, from: number): { attrs: Map<string, string>; end: number; selfClosing: boolean } | undefined {
  const attrs = new Map<string, string>();
  let i = from;
  const skipSpace = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  while (i < src.length) {
    skipSpace();
    if (src.startsWith('/>', i)) return { attrs, end: i + 2, selfClosing: true };
    if (src[i] === '>') return { attrs, end: i + 1, selfClosing: false };
    if (src[i] === '{') {
      // A spread: {...props}
      const close = findClose(src, i);
      if (close === -1) return undefined;
      i = close + 1;
      continue;
    }
    const name = /^[A-Za-z_$][\w$:-]*/.exec(src.slice(i, i + 128))?.[0];
    if (!name) return undefined;
    i += name.length;
    skipSpace();
    if (src[i] !== '=') {
      attrs.set(name, 'true');
      continue;
    }
    i++;
    skipSpace();
    if (src[i] === '{') {
      const close = findClose(src, i);
      if (close === -1) return undefined;
      attrs.set(name, src.slice(i + 1, close));
      i = close + 1;
    } else if (src[i] === '"' || src[i] === "'") {
      const end = skipNonCode(src, i);
      attrs.set(name, src.slice(i, end));
      i = end;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/** Route objects in the array passed to createBrowserRouter or useRoutes, inline or by a variable in the same file. */
function objectRoutes(file: string, src: string): Route[] {
  const routes: Route[] = [];
  for (const call of src.matchAll(/\b(?:createBrowserRouter|useRoutes)\s*\(\s*/g)) {
    let start = call.index + call[0].length;
    if (src[start] !== '[') {
      const name = /^[A-Za-z_$][\w$]*/.exec(src.slice(start, start + 128))?.[0];
      if (!name) continue;
      const declaration = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\b[^=]*=\\s*\\[`).exec(src);
      if (!declaration) continue;
      start = declaration.index + declaration[0].length - 1;
    }
    routes.push(...routeArray(file, src, start, false));
  }
  return routes;
}

function routeArray(file: string, src: string, open: number, guarded: boolean): Route[] {
  const close = findClose(src, open);
  if (close === -1) return [];
  const routes: Route[] = [];
  for (let i = open + 1; i < close; ) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = src[i]!;
    if (OPENERS.includes(c)) {
      const end = findClose(src, i);
      if (end === -1 || end > close) break;
      if (c === '{') routes.push(...routeObject(file, src, i, end, guarded));
      i = end + 1;
    } else {
      i++;
    }
  }
  return routes;
}

function routeObject(file: string, src: string, open: number, close: number, ancestorGuarded: boolean): Route[] {
  const props = new Map<string, { text: string; start: number }>();
  let i = open + 1;
  while (i < close) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (/[\s,]/.test(src[i]!)) {
      i++;
      continue;
    }
    const key = /^(?:([A-Za-z_$][\w$]*)|'([^']*)'|"([^"]*)")\s*:\s*/.exec(src.slice(i, Math.min(close, i + 256)));
    const start = key ? i + key[0].length : i;
    const end = valueEnd(src, start, close);
    if (key) props.set(key[1] ?? key[2] ?? key[3]!, { text: src.slice(start, end), start });
    i = end + 1;
  }

  const element = props.get('element')?.text;
  const guarded = ancestorGuarded || (element !== undefined && hasGuard(element));
  const routes: Route[] = [];
  const routePath = props.get('path')?.text;
  if (routePath !== undefined && element !== undefined) {
    routes.push({ file, line: lineAt(src, open), path: pathText(routePath), element, guarded });
  }
  const children = props.get('children');
  if (children && src[children.start] === '[') routes.push(...routeArray(file, src, children.start, guarded));
  return routes;
}

/** The index of the comma that ends the property value starting at `i`, or `close`. */
function valueEnd(src: string, i: number, close: number): number {
  while (i < close) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = src[i]!;
    if (OPENERS.includes(c)) {
      const end = findClose(src, i);
      if (end === -1 || end > close) return close;
      i = end + 1;
    } else if (c === ',') {
      return i;
    } else {
      i++;
    }
  }
  return close;
}
