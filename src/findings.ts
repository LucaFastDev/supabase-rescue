// The finding model, as defined in the "Report" section of docs/PRD.md.

export const CHECK_IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Entries that are not severities and never change the exit code. */
export const KINDS = ['review', 'manual'] as const;
export type Kind = (typeof KINDS)[number];

/** Where a finding is: a file and line, or a database object. */
export type Location = { file: string; line: number } | { object: string };

export interface Snippet {
  language: string;
  code: string;
}

export interface Fix {
  text: string;
  snippet?: Snippet;
}

interface FindingBase {
  check: CheckId;
  title: string;
  location: Location;
  /** Why it matters, in plain words for a client. */
  why: string;
  fix: Fix;
  /** What to verify before applying the fix. */
  checkBefore: string;
}

export type Finding = FindingBase &
  ({ severity: Severity; kind?: never } | { kind: Kind; severity?: never });

/** The six report sections, in report order. */
export const RANKS = [...SEVERITIES, ...KINDS] as const;
export type Rank = (typeof RANKS)[number];

export function rankOf(finding: Finding): Rank {
  return finding.severity ?? finding.kind;
}

/** 1 when any finding is critical or high, else 0. Review and manual never count. */
export function exitCodeFor(findings: readonly Finding[]): 0 | 1 {
  return findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? 1 : 0;
}

// Code-point comparison, so the order never depends on the machine's locale.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Files before database objects; files by path, then line number. */
export function compareLocations(a: Location, b: Location): number {
  if ('file' in a && 'file' in b) {
    return compareStrings(a.file, b.file) || a.line - b.line;
  }
  if ('object' in a && 'object' in b) {
    return compareStrings(a.object, b.object);
  }
  return 'file' in a ? -1 : 1;
}

/** Sorted by severity (then review, then manual), then check, then location. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      RANKS.indexOf(rankOf(a)) - RANKS.indexOf(rankOf(b)) ||
      compareStrings(a.check, b.check) ||
      compareLocations(a.location, b.location),
  );
}

export function formatLocation(location: Location): string {
  return 'file' in location ? `${location.file}:${location.line}` : location.object;
}
