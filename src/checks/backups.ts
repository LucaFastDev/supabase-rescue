// Check j: backups and plan. It finds nothing and only lists one manual action, because which
// Supabase plan a project is on, and so whether it is backed up and kept running, can be read
// neither from the repo nor from the database's catalogs. It reads no file and makes no network
// call, so every report lists the same entry whatever the repo holds.

import type { Finding } from '../findings.ts';
import type { Check } from './index.ts';

export const BACKUPS_MANUAL_CHECKS: Finding[] = [
  {
    check: 'j',
    kind: 'manual',
    title: 'The project is on a paid plan, with daily backups',
    location: { object: 'Supabase dashboard: Organization settings > Billing' },
    why: 'The free plan keeps no backups and pauses a project after a week without activity. A paused app is offline until someone restores it, and data lost to a bad change cannot be brought back. The tool cannot see which plan the project is on.',
    fix: {
      text: 'Move the organization to the Pro plan or above before launch. Paid projects are backed up daily and are not paused for inactivity.',
    },
    checkBefore:
      'If the project is already on a paid plan, open Database > Backups in the dashboard and check that it lists a backup from the last day.',
  },
];

export const backupsCheck: Check = {
  id: 'j',
  run() {
    return [...BACKUPS_MANUAL_CHECKS];
  },
};
