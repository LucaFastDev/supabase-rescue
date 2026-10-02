import type { CheckId, Finding } from '../findings.ts';

export interface CheckContext {
  /** Absolute path of the audited repo checkout. */
  repoPath: string;
  /** Connection string from --db, when given. */
  db?: string;
  /** Schemas the Data API exposes. */
  exposedSchemas: string[];
}

export interface Check {
  id: CheckId;
  run(context: CheckContext): Finding[] | Promise<Finding[]>;
}

/** Every check the audit runs, in order. Checks a to f are added by later tasks. */
export const checks: Check[] = [];
