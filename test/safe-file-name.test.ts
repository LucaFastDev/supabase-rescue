import { describe, expect, it } from 'vitest';
import { safeFileName } from '../demo/src/lib/safe-file-name.ts';

describe('safeFileName', () => {
  it.each([
    ['photo.png', 'photo.png'],
    ['café.png', 'caf-.png'],
    ['cut #2.png', 'cut--2.png'],
    ['what?.png', 'what-.png'],
    // A macOS screenshot's default name has a narrow no-break space (U+202F) before "AM".
    ['Screenshot 2026-10-08 at 10.00.00 AM.png', 'Screenshot-2026-10-08-at-10.00.00-AM.png'],
  ])('turns %j into %j', (name, safe) => {
    expect(safeFileName(name)).toBe(safe);
  });
});
