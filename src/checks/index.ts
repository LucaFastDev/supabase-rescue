import type { CheckId, Finding } from '../findings.ts';
import { authCheck } from './auth.ts';
import { migrationsCheck } from './migrations.ts';
import { secretsCheck } from './secrets.ts';

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

/** Every check the audit runs, in order. The database checks a to c are added by a later task. */
export const checks: Check[] = [secretsCheck, authCheck, migrationsCheck];
