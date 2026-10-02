import { describe, expect, it } from 'vitest';
import type { Finding } from '../src/findings.ts';
import { renderJson, renderMarkdown } from '../src/report.ts';
import type { ReportMeta } from '../src/report.ts';
import { RANK_CASES, finding } from './helpers.ts';

const meta: ReportMeta = { target: 'demo', tool: { name: 'supabase-rescue', version: '0.1.0' } };

const SECTIONS = ['Critical', 'High', 'Medium', 'Low', 'Review', 'Manual actions'];

/** Splits report.md into its sections, keyed by heading. */
function sections(markdown: string): Map<string, string> {
  const parts = markdown.split(/^## /m).slice(1);
  return new Map(parts.map((part) => {
    const [heading, ...body] = part.split('\n');
    return [heading!, body.join('\n').trim()];
  }));
}

describe('renderMarkdown', () => {
  it('renders an empty report with zero counts and "None." in every section', () => {
    expect(renderMarkdown([], meta)).toBe(
      [
        '# Audit report',
        '',
        '**Summary:** 0 critical, 0 high, 0 medium, 0 low; 0 to review, 0 manual actions.',
        '',
        'Target: `demo`. Tool: supabase-rescue 0.1.0.',
        '',
        '## Critical',
        '',
        'None.',
        '',
        '## High',
        '',
        'None.',
        '',
        '## Medium',
        '',
        'None.',
        '',
        '## Low',
        '',
        'None.',
        '',
        '## Review',
        '',
        'None.',
        '',
        '## Manual actions',
        '',
        'None.',
        '',
      ].join('\n'),
    );
  });

  it.each(RANK_CASES.map(({ rank }, i) => ({ rank, section: SECTIONS[i]! })))(
    'puts a $rank finding under "$section" and says "None." everywhere else',
    ({ rank, section }) => {
      const parsed = sections(renderMarkdown([finding(rank, { title: 'The finding' })], meta));
      expect([...parsed.keys()]).toEqual(SECTIONS);
      for (const [heading, body] of parsed) {
        if (heading === section) {
          expect(body).toMatch(/^### The finding\n/);
        } else {
          expect(body).toBe('None.');
        }
      }
    },
  );

  it('counts each severity and kind in the summary line', () => {
    const findings = [
      finding('critical'),
      finding('critical'),
      finding('high'),
      finding('low'),
      finding('review'),
      finding('manual'),
      finding('manual'),
      finding('manual'),
    ];
    expect(renderMarkdown(findings, meta)).toContain(
      '**Summary:** 2 critical, 1 high, 0 medium, 1 low; 1 to review, 3 manual actions.',
    );
  });

  it('renders where, why, fix with its snippet in a fenced block, and what to check first', () => {
    const withSnippet: Finding = {
      check: 'a',
      severity: 'critical',
      title: 'Table public.notes has RLS off',
      location: { object: 'public.notes' },
      why: 'Anyone with the anon key can read and change every row.',
      fix: {
        text: 'Turn RLS on, then add policies for what each role may do.',
        snippet: { language: 'sql', code: 'alter table public.notes enable row level security;\n' },
      },
      checkBefore: 'That the app has policies for every query it runs on this table.',
    };
    expect(sections(renderMarkdown([withSnippet], meta)).get('Critical')).toBe(
      [
        '### Table public.notes has RLS off',
        '',
        '- **Check:** a',
        '- **Where:** `public.notes`',
        '- **Why:** Anyone with the anon key can read and change every row.',
        '- **Fix:** Turn RLS on, then add policies for what each role may do.',
        '',
        '```sql',
        'alter table public.notes enable row level security;',
        '```',
        '',
        '- **Check before applying:** That the app has policies for every query it runs on this table.',
      ].join('\n'),
    );
  });

  it('gives a file location as path:line and omits the code block without a snippet', () => {
    const body = sections(
      renderMarkdown([finding('low', { location: { file: 'supabase/migrations/0002.sql', line: 7 } })], meta),
    ).get('Low');
    expect(body).toContain('- **Where:** `supabase/migrations/0002.sql:7`');
    expect(body).not.toContain('```');
  });

  it('uses a longer fence when the snippet itself contains a fence', () => {
    const f = finding('high');
    f.fix.snippet = { language: 'md', code: '```sh\nnpm test\n```' };
    expect(renderMarkdown([f], meta)).toContain('````md\n```sh\nnpm test\n```\n````');
  });

  it('lists findings in sorted order within a section', () => {
    const body = sections(
      renderMarkdown(
        [finding('high', { check: 'c', title: 'Second' }), finding('high', { check: 'b', title: 'First' })],
        meta,
      ),
    ).get('High')!;
    expect(body.indexOf('### First')).toBeLessThan(body.indexOf('### Second'));
  });
});

describe('renderJson', () => {
  it('holds the tool, the target as given, and the sorted findings, with no timestamp', () => {
    const findings = [finding('low', { title: 'low' }), finding('critical', { title: 'critical' })];
    const json = renderJson(findings, meta);
    expect(json.endsWith('}\n')).toBe(true);
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed)).toEqual(['tool', 'target', 'findings']);
    expect(parsed.tool).toEqual({ name: 'supabase-rescue', version: '0.1.0' });
    expect(parsed.target).toBe('demo');
    expect(parsed.findings.map((f: Finding) => f.title)).toEqual(['critical', 'low']);
    expect(parsed.findings[0]).toEqual(findings[1]);
  });
});
