import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rlsCheck } from '../src/checks/rls.ts';
import type { Fixture } from './database.ts';
import { inSchema, openFixture } from './database.ts';

let fx: Fixture;
let hidden: string;

beforeAll(async () => {
  fx = await openFixture();
  hidden = await fx.newSchema();
  const s = fx.schema;
  await fx.sql(`
    create table ${s}.open_notes (id int);
    create table ${s}.locked_notes (id int);
    alter table ${s}.locked_notes enable row level security;
    create table ${s}.events (id int, at date) partition by range (at);
    create table ${s}."Mixed Case" (id int);
    create view ${s}.notes_view as select id from ${s}.open_notes;
    create materialized view ${s}.notes_mv as select id from ${s}.open_notes;
    create table ${hidden}.open_hidden (id int);
  `);
});

afterAll(async () => {
  await fx?.close();
});

describe('check a: tables without RLS', () => {
  it('reports a table in an exposed schema with RLS off as critical, at schema.table', async () => {
    const findings = inSchema(await rlsCheck.run(fx.context()), fx.schema);
    const notes = findings.find((f) => 'object' in f.location && f.location.object === `${fx.schema}.open_notes`);
    expect(notes).toMatchObject({
      check: 'a',
      severity: 'critical',
      title: `Table ${fx.schema}.open_notes has row level security off`,
      location: { object: `${fx.schema}.open_notes` },
    });
    expect(notes!.fix.snippet!.code).toContain(`alter table ${fx.schema}.open_notes enable row level security;`);
    expect(notes!.fix.text).toMatch(/who should be allowed/);
    expect(notes!.checkBefore).toMatch(/with no policy blocks every read and write by anyone but the table's owner/);
  });

  it('reports partitioned tables, and quotes names that need it in the SQL', async () => {
    const findings = inSchema(await rlsCheck.run(fx.context()), fx.schema);
    const objects = findings.map((f) => ('object' in f.location ? f.location.object : '')).sort();
    expect(objects).toEqual([`${fx.schema}.Mixed Case`, `${fx.schema}.events`, `${fx.schema}.open_notes`]);
    const mixed = findings.find((f) => 'object' in f.location && f.location.object === `${fx.schema}.Mixed Case`)!;
    expect(mixed.fix.snippet!.code).toContain(`alter table ${fx.schema}."Mixed Case" enable row level security;`);
  });

  it('does not report a table with RLS on, a view or a materialized view', async () => {
    const objects = inSchema(await rlsCheck.run(fx.context()), fx.schema).map((f) => 'object' in f.location && f.location.object);
    expect(objects).not.toContain(`${fx.schema}.locked_notes`);
    expect(objects).not.toContain(`${fx.schema}.notes_view`);
    expect(objects).not.toContain(`${fx.schema}.notes_mv`);
  });

  it('does not report a table in a schema that is not exposed', async () => {
    expect(inSchema(await rlsCheck.run(fx.context([fx.schema])), hidden)).toEqual([]);
    expect(inSchema(await rlsCheck.run(fx.context([fx.schema, hidden])), hidden)).toHaveLength(1);
  });
});
