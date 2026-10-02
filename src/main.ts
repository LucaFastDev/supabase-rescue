import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAudit } from './audit.ts';
import { checks as defaultChecks } from './checks/index.ts';
import type { Check, CheckContext } from './checks/index.ts';
import { exitCodeFor } from './findings.ts';
import { renderJson, renderMarkdown } from './report.ts';
import type { ReportMeta } from './report.ts';

export interface MainOptions {
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  checks?: readonly Check[];
}

const USAGE = 'usage: audit <path> [--db <connection string>] [--out <dir>] | role-sql';

/**
 * Runs the CLI and returns its exit code: 0 nothing critical or high, 1 something critical or
 * high, 2 the audit could not run (bad arguments, a bad path, an error while writing).
 */
export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const [command, ...rest] = argv;

  try {
    if (command === 'role-sql') {
      stdout('-- role-sql is not implemented yet.\n');
      return 0;
    }
    if (command === 'audit') {
      return await audit(rest, cwd, stderr, options.checks ?? defaultChecks);
    }
    stderr(`${USAGE}\n`);
    return 2;
  } catch (error) {
    stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

async function audit(
  args: string[],
  cwd: string,
  stderr: (text: string) => void,
  registry: readonly Check[],
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { db: { type: 'string' }, out: { type: 'string' } },
  });
  if (positionals.length !== 1) {
    stderr(`${USAGE}\n`);
    return 2;
  }

  const target = positionals[0]!;
  const repoPath = path.resolve(cwd, target);
  const info = await stat(repoPath).catch(() => undefined);
  if (!info?.isDirectory()) {
    stderr(`error: ${target} is not a directory\n`);
    return 2;
  }

  const context: CheckContext = {
    repoPath,
    ...(values.db !== undefined && { db: values.db }),
    // Reading config.toml's [api] schemas comes with the database checks.
    exposedSchemas: ['public'],
  };
  const findings = await runAudit(context, registry);

  const meta: ReportMeta = { target, tool: await toolInfo() };
  const outDir = path.resolve(cwd, values.out ?? '.');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'report.md'), renderMarkdown(findings, meta));
  await writeFile(path.join(outDir, 'report.json'), renderJson(findings, meta));

  return exitCodeFor(findings);
}

async function toolInfo(): Promise<ReportMeta['tool']> {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return { name: pkg.name, version: pkg.version };
}
