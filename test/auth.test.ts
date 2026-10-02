import { describe, expect, it } from 'vitest';
import { MANUAL_CHECKS, authCheck, callsData, importsOf } from '../src/checks/auth.ts';
import type { Finding } from '../src/findings.ts';
import { tempDir, writeFiles } from './repo.ts';

const run = async (repoPath: string) => authCheck.run({ repoPath, exposedSchemas: ['public'] });
const notManual = (findings: Finding[]) => findings.filter((f) => f.kind !== 'manual');
const reviews = (findings: Finding[]) =>
  findings.filter((f) => f.kind === 'review').map((f) => [f.title, 'file' in f.location && `${f.location.file}:${f.location.line}`]);

// Pages the route fixtures render.
const PAGES = {
  'src/pages/Home.tsx': 'export default function Home() { return <h1>Hi</h1>; }\n',
  'src/pages/Dashboard.tsx':
    "import { supabase } from '../lib/supabase';\nexport default function Dashboard() {\n  supabase.from('appointments').select('*');\n  return null;\n}\n",
  'src/pages/Notes.tsx':
    "import { supabase } from '../lib/supabase';\nexport function Notes() {\n  supabase\n    .rpc('list_notes');\n  return null;\n}\n",
  'src/pages/Profile.tsx':
    "import { useAuth } from '../hooks/useAuth';\nexport default function Profile() { const { user } = useAuth(); supabase.from('profiles').select(); return null; }\n",
  'src/pages/Account/index.tsx':
    "export default function Account() { const { data } = await supabase.auth.getUser(); supabase.from('accounts').select(); return null; }\n",
  'src/pages/Stats.tsx': 'export default function Stats() { return Array.from([1, 2]).map(String); }\n',
  'src/pages/Admin.tsx': "export default function Admin() { supabase.from('staff_notes').select(); return null; }\n",
  'src/pages/Reports.jsx': "export default function Reports() { supabase.from('reports').select(); return null; }\n",
};

describe('check e: config.toml', () => {
  it('is medium at the enable_confirmations line of [auth.email] when it is false', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'supabase/config.toml': '[auth]\nenabled = true\n\n[auth.sms]\nenable_confirmations = true\n\n[auth.email]\nenable_signup = true\nenable_confirmations = false\n',
    });
    const findings = notManual(await run(root));
    expect(findings.map((f) => [f.severity, f.location, f.title])).toEqual([
      ['medium', { file: 'supabase/config.toml', line: 9 }, 'Email confirmation is off in config.toml'],
    ]);
    expect(findings[0]!.fix.snippet).toEqual({ language: 'toml', code: '[auth.email]\nenable_confirmations = true\n' });
  });

  it.each([
    { name: 'it is true', toml: '[auth.email]\nenable_confirmations = true\n' },
    { name: 'the key is absent', toml: '[auth.email]\nenable_signup = true\n' },
    { name: 'only [auth.sms] turns it off', toml: '[auth.sms]\nenable_confirmations = false\n' },
  ])('gives nothing when $name', async ({ toml }) => {
    const root = await tempDir();
    await writeFiles(root, { 'supabase/config.toml': toml });
    expect(notManual(await run(root))).toEqual([]);
  });
});

describe('check e: manual entries', () => {
  it('always lists the five dashboard checks once, with where to look', async () => {
    const findings = await run(await tempDir());
    expect(findings).toEqual(MANUAL_CHECKS);
    expect(findings.map((f) => [f.kind, f.title, 'object' in f.location && f.location.object])).toEqual([
      ['manual', 'Confirm email is on', 'Supabase dashboard: Authentication > Sign In / Providers > Email'],
      ['manual', 'Secure email change is on', 'Supabase dashboard: Authentication > Sign In / Providers > Email'],
      ['manual', 'Leaked password protection is on', 'Supabase dashboard: Authentication > Attack Protection'],
      ['manual', 'Minimum password length is at least 8', 'Supabase dashboard: Authentication > Attack Protection'],
      ['manual', "Site URL and redirect URLs list only the app's own domains", 'Supabase dashboard: Authentication > URL Configuration'],
    ]);
  });
});

describe('check e: routes', () => {
  it('gives a review entry for a JSX route that renders data without an auth check, and nothing for the others', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      ...PAGES,
      'src/App.tsx': [
        "import Home from './pages/Home';", // 1
        "import Dashboard from './pages/Dashboard';",
        "import { Notes } from './pages/Notes';",
        "import Profile from './pages/Profile';",
        "import Account from './pages/Account';", // 5
        "import Stats from './pages/Stats';",
        "import Admin from './pages/Admin';",
        "import ProtectedRoute from './components/ProtectedRoute';",
        "import Settings from '@/pages/Settings';",
        '', // 10
        'export default function App() {',
        '  return (',
        '    <Routes>',
        '      <Route path="/" element={<Home />} />',
        '      <Route path="/dashboard" element={<Dashboard />} />', // 15
        '      <Route path="/profile" element={<Profile />} />',
        "      <Route path={'/account'} element={<Account />} />",
        '      <Route path="/stats" element={<Stats />} />',
        '      <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />',
        '      <Route element={<RequireAuth />}>', // 20
        '        <Route path="/notes" element={<Notes />} />',
        '      </Route>',
        '      <Route path="/settings" element={<Settings />} />',
        '      <Route path="/missing" element={<Missing />} />',
        '      <Route',
        '        path="/later"',
        '        element={<Layout><Notes /></Layout>}',
        '      />',
        '    </Routes>',
        '  );',
        '}',
      ].join('\n'),
    });
    const findings = await run(root);
    expect(reviews(findings)).toEqual([
      ['Route /dashboard renders data without an auth check', 'src/App.tsx:15'],
      ['Route /later renders data without an auth check', 'src/App.tsx:25'],
    ]);
    expect(findings[0]!.why).toContain('src/pages/Dashboard.tsx');
  });

  it('reads route objects passed to createBrowserRouter or useRoutes, with children under a guard', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      ...PAGES,
      'src/router.tsx': [
        "import Dashboard from './pages/Dashboard';", // 1
        "import Admin from './pages/Admin';",
        "import Home from './pages/Home';",
        '',
        'export const router = createBrowserRouter([', // 5
        "  { path: '/', element: <Home /> },",
        '  {',
        "    path: '/dashboard',",
        '    element: <Dashboard />,',
        '  },', // 10
        '  {',
        '    element: <RequireAuth />,',
        "    children: [{ path: '/admin', element: <Admin /> }],",
        '  },',
        "  { path: '/app', element: <Shell />, children: [{ path: 'admin', element: <Admin /> }] },", // 15
        ']);',
      ].join('\n'),
      'src/Routes.jsx': [
        "import Reports from './pages/Reports.jsx';", // 1
        "const Lazy = lazy(() => import('./pages/Admin'));",
        'const routes = [',
        "  { path: '/reports', element: <Reports /> },",
        "  { path: '/lazy', element: (", // 5
        '      <Suspense fallback={<p>Loading, please wait</p>}>',
        '        <Lazy />',
        '      </Suspense>',
        '    ) },',
        '];', // 10
        'export function AppRoutes() { return useRoutes(routes); }',
      ].join('\n'),
    });
    expect(reviews(await run(root))).toEqual([
      ['Route /reports renders data without an auth check', 'src/Routes.jsx:4'],
      ['Route /lazy renders data without an auth check', 'src/Routes.jsx:5'],
      ['Route /dashboard renders data without an auth check', 'src/router.tsx:7'],
      ['Route admin renders data without an auth check', 'src/router.tsx:15'],
    ]);
  });

  it('gives no review entry when every data route is guarded', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      ...PAGES,
      'src/App.tsx': [
        "import Dashboard from './pages/Dashboard';",
        "import Admin from './pages/Admin';",
        '<Routes>',
        '  <Route path="/dashboard" element={<PrivateRoute><Dashboard /></PrivateRoute>} />',
        '  <Route path="/app" element={<AuthenticatedLayout />}>',
        '    <Route path="admin" element={<Admin />} />',
        '  </Route>',
        '</Routes>',
      ].join('\n'),
    });
    expect(reviews(await run(root))).toEqual([]);
  });

  it('follows imports through the @/ alias to <root>/src, from a file in any folder', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      ...PAGES,
      'src/routes/AppRoutes.tsx': [
        "import Dashboard from '@/pages/Dashboard';", // 1
        "import Admin from '@/pages/Admin';",
        "import { Notes } from '@/pages/Notes';",
        "import ProtectedRoute from '@/components/ProtectedRoute';",
        "const Reports = lazy(() => import('@/pages/Reports.jsx'));", // 5
        '',
        '<Routes>',
        '  <Route path="/dashboard" element={<Dashboard />} />',
        '  <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />',
        '  <Route element={<ProtectedRoute />}>', // 10
        '    <Route path="/notes" element={<Notes />} />',
        '  </Route>',
        '  <Route path="/reports" element={<Reports />} />',
        '</Routes>',
      ].join('\n'),
    });
    const findings = await run(root);
    expect(reviews(findings)).toEqual([
      ['Route /dashboard renders data without an auth check', 'src/routes/AppRoutes.tsx:8'],
      ['Route /reports renders data without an auth check', 'src/routes/AppRoutes.tsx:13'],
    ]);
    expect(findings[0]!.why).toContain('(src/pages/Dashboard.tsx)');
  });

  it('gives no review entry for an @/ import that names no file under src/', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'pages/Dashboard.tsx': PAGES['src/pages/Dashboard.tsx'],
      'src/App.tsx': "import Dashboard from '@/pages/Dashboard';\n<Route path=\"/dashboard\" element={<Dashboard />} />\n",
    });
    expect(reviews(await run(root))).toEqual([]);
  });

  it('reads only src/, and skips an odd file without failing', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      ...PAGES,
      'app/App.tsx': "import Dashboard from '../src/pages/Dashboard';\n<Route path=\"/x\" element={<Dashboard />} />\n",
      'src/broken.tsx': "import Dashboard from './pages/Dashboard';\n<Route path=\"/y\" element={<Dashboard />\ncreateBrowserRouter([{ path: '/z', element: <Dashboard /> \n<Route path=\"/q\" element=",
      'src/notes.txt': "<Route path=\"/n\" element={<Dashboard />} />\n",
    });
    expect(reviews(await run(root))).toEqual([]);
  });
});

describe('importsOf', () => {
  it('maps default, named, aliased and lazy imports of relative paths', () => {
    const src = [
      "import A, { B, C as D, type E } from './x';",
      "import type F from './f';",
      "import G from 'react-router-dom';",
      "import * as H from './h';",
      "const I = React.lazy(() => import('../i'));",
    ].join('\n');
    expect(Object.fromEntries(importsOf(src))).toEqual({ A: './x', B: './x', D: './x', I: '../i' });
  });

  it('maps imports through the @/ alias, but not other scoped packages', () => {
    const src = [
      "import Book from '@/pages/Book';",
      "import { Button } from '@/components/ui/button';",
      "import { createClient } from '@supabase/supabase-js';",
      "const Reports = lazy(() => import('@/pages/Reports'));",
    ].join('\n');
    expect(Object.fromEntries(importsOf(src))).toEqual({
      Book: '@/pages/Book',
      Button: '@/components/ui/button',
      Reports: '@/pages/Reports',
    });
  });
});

describe('callsData', () => {
  it.each([
    ["supabase.from('t').select()", true],
    ["supabase\n  .from('t')", true],
    ["db.rpc('f')", true],
    ['Array.from(items)', false],
    ['Buffer.from(text)', false],
    ['const x = 1;', false],
  ])('%j is %s', (src, expected) => {
    expect(callsData(src)).toBe(expected);
  });
});
