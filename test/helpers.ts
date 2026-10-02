import type { CheckId, Finding, Kind, Location, Severity } from '../src/findings.ts';

export const RANK_CASES: { rank: Severity | Kind; exitCode: 0 | 1 }[] = [
  { rank: 'critical', exitCode: 1 },
  { rank: 'high', exitCode: 1 },
  { rank: 'medium', exitCode: 0 },
  { rank: 'low', exitCode: 0 },
  { rank: 'review', exitCode: 0 },
  { rank: 'manual', exitCode: 0 },
];

/** A finding of the given severity or kind, with placeholder text. */
export function finding(
  rank: Severity | Kind,
  fields: { check?: CheckId; title?: string; location?: Location } = {},
): Finding {
  const base = {
    check: fields.check ?? 'a',
    title: fields.title ?? `A ${rank} finding`,
    location: fields.location ?? { file: 'supabase/migrations/0001_init.sql', line: 1 },
    why: 'Why it matters.',
    fix: { text: 'How to fix it.' },
    checkBefore: 'What to check first.',
  };
  return rank === 'review' || rank === 'manual' ? { ...base, kind: rank } : { ...base, severity: rank };
}
