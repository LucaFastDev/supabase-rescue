import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** Directories a walk never enters. */
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

/**
 * Every regular file under `dir`, as POSIX paths relative to `root`, sorted. Skips `node_modules/`
 * and `.git/` at any depth, and never follows a symlink. A missing `dir` gives no files.
 */
export async function walkFiles(root: string, dir: string = root): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) files.push(...(await walkFiles(root, full)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  return files.sort();
}
