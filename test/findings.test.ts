import { describe, expect, it } from 'vitest';
import { exitCodeFor, sortFindings } from '../src/findings.ts';
import { RANK_CASES, finding } from './helpers.ts';

describe('exitCodeFor', () => {
  it.each(RANK_CASES)('is $exitCode for a single $rank finding', ({ rank, exitCode }) => {
    expect(exitCodeFor([finding(rank)])).toBe(exitCode);
  });

  it('is 0 with no findings', () => {
    expect(exitCodeFor([])).toBe(0);
  });

  it('is 0 when everything is medium, low, review or manual', () => {
    const findings = (['medium', 'low', 'review', 'manual'] as const).map((rank) => finding(rank));
    expect(exitCodeFor(findings)).toBe(0);
  });

  it('is 1 when one high finding sits among lower ones', () => {
    const findings = (['low', 'review', 'high', 'manual'] as const).map((rank) => finding(rank));
    expect(exitCodeFor(findings)).toBe(1);
  });
});

describe('sortFindings', () => {
  const unsorted = [
    finding('manual', { check: 'a', title: 'manual a' }),
    finding('review', { check: 'e', title: 'review e' }),
    finding('low', { check: 'f', title: 'low f' }),
    finding('medium', { check: 'b', title: 'medium b' }),
    finding('high', { check: 'a', title: 'high a' }),
    finding('critical', { check: 'f', title: 'critical f' }),
    finding('critical', { check: 'a', location: { object: 'public.notes' }, title: 'critical a object' }),
    finding('critical', { check: 'a', location: { file: 'src/b.ts', line: 1 }, title: 'critical a b.ts:1' }),
    finding('critical', { check: 'a', location: { file: 'src/a.ts', line: 10 }, title: 'critical a a.ts:10' }),
    finding('critical', { check: 'a', location: { file: 'src/a.ts', line: 2 }, title: 'critical a a.ts:2' }),
    finding('critical', { check: 'a', location: { object: 'public.customers' }, title: 'critical a customers' }),
  ];

  it('orders by severity, then review, then manual; then check; then location', () => {
    expect(sortFindings(unsorted).map((f) => f.title)).toEqual([
      'critical a a.ts:2',
      'critical a a.ts:10',
      'critical a b.ts:1',
      'critical a customers',
      'critical a object',
      'critical f',
      'high a',
      'medium b',
      'low f',
      'review e',
      'manual a',
    ]);
  });

  it('leaves its input unchanged', () => {
    const before = unsorted.map((f) => f.title);
    sortFindings(unsorted);
    expect(unsorted.map((f) => f.title)).toEqual(before);
  });
});
