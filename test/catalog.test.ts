import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SKIPPED_SCHEMAS, isSkippedSchema } from '../src/catalog.ts';
import { functionsCheck } from '../src/checks/functions.ts';
import { policiesCheck } from '../src/checks/policies.ts';
import { NO_DB, rlsCheck } from '../src/checks/rls.ts';
import type { Finding } from '../src/findings.ts';
import { main } from '../src/main.ts';
import type { Fixture } from './database.ts';
import { inSchema, openFixture } from './database.ts';
import { tempDir } from './repo.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('isSkippedSchema', () => {
  it('matches the listed schemas and the temporary ones, and nothing else', () => {
    for (const schema of SKIPPED_SCHEMAS) expect(isSkippedSchema(schema), schema).toBe(true);
    for (const schema of ['pg_temp_3', 'pg_toast_temp_12']) expect(isSkippedSchema(schema), schema).toBe(true);
    for (const schema of ['public', 'api', 'pg_tempest', 'authx']) expect(isSkippedSchema(schema), schema).toBe(false);
  });
});

describe('checks a, b and c on the demo stack', () => {
  let fx: Fixture;
  let findings: Finding[];

  beforeAll(async () => {
    fx = await openFixture();
    // isn is an extension the demo stack does not install: its functions land in the fixture
    // schema, executable by PUBLIC, and must be skipped as extension members.
    await fx.sql(`create extension isn with schema ${fx.schema}`);
    await fx.sql(`create table ${fx.schema}.open_notes (id int)`);
    const context = fx.context(['public', 'graphql_public', 'auth', 'storage', 'extensions', fx.schema]);
    findings = [];
    for (const check of [rlsCheck, policiesCheck, functionsCheck]) findings.push(...(await check.run(context)));
  });

  afterAll(async () => {
    await fx?.close();
  });

  it('report no object in a skipped schema, even when config.toml exposes it', () => {
    const schemas = new Set(findings.map((f) => ('object' in f.location ? f.location.object.split('.')[0]! : '')));
    expect([...schemas].filter(isSkippedSchema)).toEqual([]);
  });

  it("report no object that belongs to an extension, though the extension's functions are in an exposed schema", async () => {
    const { rows } = await fx.sql(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = '${fx.schema}'`,
    );
    expect(rows[0].n).toBeGreaterThan(0);
    expect(inSchema(findings, fx.schema).map((f) => f.location)).toEqual([{ object: `${fx.schema}.open_notes` }]);
  });
});

describe('without --db', () => {
  it('checks a, b and c open no connection; a reports one manual entry, b and c nothing', async () => {
    const connect = vi.spyOn(pg.Client.prototype, 'connect');
    try {
      const context = { repoPath: os.tmpdir(), exposedSchemas: ['public'] };
      expect(await rlsCheck.run(context)).toEqual([NO_DB]);
      expect(await policiesCheck.run(context)).toEqual([]);
      expect(await functionsCheck.run(context)).toEqual([]);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });

  it('the report carries exactly one manual entry saying the database checks did not run, and with --db it is absent', async () => {
    const fx = await openFixture();
    try {
      const without = await tempDir();
      const withDb = await tempDir();
      await main(['audit', 'test/fixtures/empty-repo', '--out', without], { cwd: root });
      await main(['audit', 'test/fixtures/empty-repo', '--db', fx.url, '--out', withDb], { cwd: root });
      const read = async (dir: string) =>
        JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8')).findings as Finding[];

      const entries = (await read(without)).filter((f) => f.title === NO_DB.title);
      expect(entries).toEqual([NO_DB]);
      expect(NO_DB.kind).toBe('manual');
      expect(NO_DB.fix.text).toMatch(/role-sql/);
      expect(NO_DB.fix.snippet!.code).toMatch(/--db/);
      expect((await read(without)).filter((f) => ['a', 'b', 'c'].includes(f.check))).toEqual([NO_DB]);

      expect((await read(withDb)).filter((f) => f.title === NO_DB.title)).toEqual([]);
    } finally {
      await fx.close();
    }
  });
});
