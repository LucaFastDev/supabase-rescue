import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Check, CheckContext } from '../src/checks/index.ts';
import { exposedSchemas, readConfig } from '../src/config.ts';
import { main } from '../src/main.ts';
import { tempDir, writeFiles } from './repo.ts';

async function withConfig(toml?: string): Promise<string> {
  const root = await tempDir();
  if (toml !== undefined) await writeFiles(root, { 'supabase/config.toml': toml });
  return root;
}

describe('readConfig', () => {
  it('reads [api] schemas and [auth.email] enable_confirmations with its line', async () => {
    const root = await withConfig(
      'project_id = "x"\n\n[api]\nschemas = ["public", "graphql_public", "api"]\n\n[auth.email]\nenable_confirmations = false\n',
    );
    expect(await readConfig(root)).toEqual({
      apiSchemas: ['public', 'graphql_public', 'api'],
      enableConfirmations: { value: false, line: 7 },
    });
  });

  it('is undefined when there is no config file', async () => {
    expect(await readConfig(await withConfig())).toBeUndefined();
  });

  it('has no schemas and no enable_confirmations when neither is written', async () => {
    expect(await readConfig(await withConfig('[db]\nport = 54322\n'))).toEqual({ apiSchemas: [] });
  });

  it('throws, naming the file, when it is not valid TOML', async () => {
    await expect(readConfig(await withConfig('[api\nschemas = '))).rejects.toThrow(/^supabase\/config\.toml is not valid TOML: /);
  });
});

describe('exposedSchemas', () => {
  it.each([
    { name: 'a file with extra schemas', config: { apiSchemas: ['graphql_public', 'public', 'api', 'api'] }, expected: ['public', 'graphql_public', 'api'] },
    { name: 'no file', config: undefined, expected: ['public'] },
    { name: 'a file with no [api] section', config: { apiSchemas: [] }, expected: ['public'] },
  ])('is public plus [api] schemas, deduplicated, for $name', ({ config, expected }) => {
    expect(exposedSchemas(config)).toEqual(expected);
  });
});

describe('the audit', () => {
  async function contextFor(root: string): Promise<CheckContext> {
    const seen: CheckContext[] = [];
    const recorder: Check = { id: 'a', run: (context) => (seen.push(context), []) };
    const out = await tempDir();
    const code = await main(['audit', root, '--out', out], { checks: [recorder], stderr: () => {} });
    expect(code).toBe(0);
    return seen[0]!;
  }

  it.each([
    { name: 'a file with extra schemas', toml: '[api]\nschemas = ["public", "storage", "graphql_public", "storage"]\n', expected: ['public', 'storage', 'graphql_public'] },
    { name: 'no file', toml: undefined, expected: ['public'] },
    { name: 'a file with no [api] section', toml: '[auth]\nenabled = true\n', expected: ['public'] },
  ])('sets exposedSchemas from config.toml for $name', async ({ toml, expected }) => {
    expect((await contextFor(await withConfig(toml))).exposedSchemas).toEqual(expected);
  });

  it('exits 2 with a one-line error, writing nothing, when config.toml is not valid TOML', async () => {
    const root = await withConfig('[api\n');
    const out = await tempDir();
    let stderr = '';
    const code = await main(['audit', root, '--out', out], { checks: [], stderr: (text) => (stderr += text) });
    expect(code).toBe(2);
    expect(stderr).toMatch(/^error: supabase\/config\.toml is not valid TOML: [^\n]*\n$/);
    expect(await readdir(out)).toEqual([]);
  });
});
