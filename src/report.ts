import { RANKS, formatLocation, rankOf, sortFindings } from './findings.ts';
import type { Finding, Rank } from './findings.ts';

export interface ReportMeta {
  /** The audited path, as given on the command line. */
  target: string;
  tool: { name: string; version: string };
}

const SECTION_TITLES: Record<Rank, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  review: 'Review',
  manual: 'Manual actions',
};

/** report.json: no timestamps, so the same input always gives the same bytes. */
export function renderJson(findings: readonly Finding[], meta: ReportMeta): string {
  const report = { tool: meta.tool, target: meta.target, findings: sortFindings(findings) };
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** report.md: counts first, then one section per severity, review and manual actions. */
export function renderMarkdown(findings: readonly Finding[], meta: ReportMeta): string {
  const sorted = sortFindings(findings);
  const count = (rank: Rank) => sorted.filter((f) => rankOf(f) === rank).length;

  const lines = [
    '# Audit report',
    '',
    `**Summary:** ${count('critical')} critical, ${count('high')} high, ${count('medium')} medium, ` +
      `${count('low')} low; ${count('review')} to review, ${count('manual')} manual actions.`,
    '',
    `Target: ${codeSpan(meta.target)}. Tool: ${meta.tool.name} ${meta.tool.version}.`,
  ];

  for (const rank of RANKS) {
    lines.push('', `## ${SECTION_TITLES[rank]}`, '');
    const section = sorted.filter((f) => rankOf(f) === rank);
    if (section.length === 0) {
      lines.push('None.');
      continue;
    }
    section.forEach((finding, i) => {
      if (i > 0) lines.push('');
      lines.push(...renderFinding(finding));
    });
  }

  return `${lines.join('\n')}\n`;
}

function renderFinding(finding: Finding): string[] {
  const lines = [
    `### ${finding.title}`,
    '',
    `- **Check:** ${finding.check}`,
    `- **Where:** ${codeSpan(formatLocation(finding.location))}`,
    `- **Why:** ${finding.why}`,
    `- **Fix:** ${finding.fix.text}`,
  ];
  const { snippet } = finding.fix;
  if (snippet) {
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(snippet.code) + 1));
    lines.push('', `${fence}${snippet.language}`, snippet.code.replace(/\n$/, ''), fence, '');
  }
  lines.push(`- **Check before applying:** ${finding.checkBefore}`);
  return lines;
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

function codeSpan(text: string): string {
  const ticks = '`'.repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}
