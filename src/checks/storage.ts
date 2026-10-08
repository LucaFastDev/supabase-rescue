// Check k: a public storage bucket with a read policy that restricts who may read its files. A
// public bucket serves every file to anyone who has its URL, whatever the policies on
// storage.objects say, so such a policy only gives false confidence: high. One finding per bucket.
// Private buckets, and public buckets whose read policies are all open, are no finding. Without
// --db it runs no query and reports nothing; check a's manual entry says the database checks did
// not run.

import { catalogFor } from '../catalog.ts';
import type { BucketRow, StoragePolicyRow } from '../catalog.ts';
import type { Finding } from '../findings.ts';
import type { Check } from './index.ts';
import { isJustTrue } from './policies.ts';

/** The bucket id as Postgres deparses a text literal in a policy's expression. */
function literal(id: string): string {
  return `'${id.replaceAll("'", "''")}'::text`;
}

/**
 * True when the policy governs reads of this bucket's files: its expression names the bucket id
 * as a literal, or does not mention bucket_id at all, so it applies to every bucket.
 */
export function appliesTo(policy: Pick<StoragePolicyRow, 'qual'>, bucketId: string): boolean {
  if (policy.qual === null || !/\bbucket_id\b/.test(policy.qual)) return true;
  return policy.qual.includes(literal(bucketId));
}

/**
 * True when the policy lets everyone read this bucket's files: permissive, for public or for both
 * anon and authenticated, with no condition beyond the bucket. Anything else restricts reading.
 */
export function isOpen(policy: StoragePolicyRow, bucketId: string): boolean {
  if (policy.permissive !== 'PERMISSIVE') return false;
  const everyone = policy.roles.includes('public') || (policy.roles.includes('anon') && policy.roles.includes('authenticated'));
  const qual = policy.qual?.trim() ?? null;
  return everyone && (qual === null || isJustTrue(qual) || qual === `(bucket_id = ${literal(bucketId)})`);
}

/** The read policies that apply to the bucket and restrict who may read its files. */
export function restrictingPolicies(bucketId: string, policies: readonly StoragePolicyRow[]): StoragePolicyRow[] {
  return policies.filter((policy) => appliesTo(policy, bucketId) && !isOpen(policy, bucketId));
}

export const storageCheck: Check = {
  id: 'k',
  async run(context) {
    const catalog = catalogFor(context);
    if (!catalog) return [];
    const { buckets, storageReadPolicies } = await catalog;
    if (buckets === 'no-privilege') return [NO_BUCKETS];
    const findings: Finding[] = [];
    for (const bucket of buckets.filter((b) => b.public)) {
      const restricting = restrictingPolicies(bucket.id, storageReadPolicies);
      if (restricting.length > 0) findings.push(publicBucket(bucket, restricting));
    }
    return findings;
  },
};

function sqlString(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function publicBucket(bucket: BucketRow, restricting: readonly StoragePolicyRow[]): Finding {
  const names = restricting.map((p) => `"${p.name}"`).join(', ');
  const policies = restricting.length === 1 ? `policy ${names} on storage.objects limits` : `policies ${names} on storage.objects limit`;
  return {
    check: 'k',
    severity: 'high',
    title: 'Public storage bucket with a read policy that does not protect its files',
    location: { object: `storage.buckets/${bucket.id}` },
    why: `The bucket ${bucket.id} is public, and the read ${policies} who may read its files. A public bucket lets anyone who has a file's URL download it, whatever the policies say: storage policies only control what the API lists and returns, not the public URL. So anyone a link reaches, or who guesses one, can open these files, though the policy makes them look private.`,
    fix: {
      text: 'Make the bucket private (in the dashboard under Storage, or with the SQL below), and show its files through signed URLs, which expire, with createSignedUrl instead of getPublicUrl. If the files are meant to be public, the restricting policy can go instead.',
      snippet: {
        language: 'sql',
        code: [
          `update storage.buckets set public = false where id = ${sqlString(bucket.id)};`,
          '',
          '-- Then, in the app, a signed URL for each file instead of getPublicUrl, for example for an hour:',
          `-- const { data } = await supabase.storage.from(${sqlString(bucket.id)}).createSignedUrl(path, 60 * 60);`,
          '',
        ].join('\n'),
      },
    },
    checkBefore:
      "Which pages and emails show these files: once the bucket is private, every public URL stops working, including links already sent or saved, so move the app to signed URLs in the same release. A signed URL works only for the users the bucket's read policies allow, so check those policies let the right people read.",
  };
}

export const NO_BUCKETS: Finding = {
  check: 'k',
  kind: 'review',
  title: 'Check k could not read the storage buckets',
  location: { object: 'storage.buckets' },
  why: 'Check k looks for public storage buckets whose files are meant to be private. The role the audit connected as may not read storage.buckets, so the audit cannot say which buckets are public. An audit role made with an older role-sql has no access to it.',
  fix: {
    text: 'Run the SQL that the current role-sql prints again, as the postgres user, and run the audit again. Running it again is safe. It gives the audit role read access to the id, name and public columns of storage.buckets, so check k can see which buckets are public.',
    snippet: {
      language: 'sh',
      code: 'npm run --silent role-sql > role.sql   # apply it again as postgres\n',
    },
  },
  checkBefore: 'That you run it as the postgres user, against the same database the audit reads.',
};
