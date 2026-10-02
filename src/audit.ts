import type { Check, CheckContext } from './checks/index.ts';
import { sortFindings } from './findings.ts';
import type { Finding } from './findings.ts';

/** Runs every check in the registry, in order, and returns all their findings, sorted. */
export async function runAudit(context: CheckContext, registry: readonly Check[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const check of registry) {
    findings.push(...(await check.run(context)));
  }
  return sortFindings(findings);
}
