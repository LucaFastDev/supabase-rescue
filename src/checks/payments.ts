// Check g: payments (Stripe). Reads only the repo, never the database, and reports three things:
// an amount passed to Stripe that comes from the request body (g1, critical), a Stripe webhook
// handler that never verifies Stripe's signature (g2, critical), and a Stripe test publishable key
// in a production env file (g3, high).
//
// Like checks d, e and f this is a line scanner over source text, not a parser: it follows the
// request body one step, within one file, from single-line declarations. A case it misses is
// acceptable; a crash on odd source text is not.

import path from 'node:path';
import { walkFiles } from '../files.ts';
import type { Finding } from '../findings.ts';
import type { Check } from './index.ts';
import { git, inGitRepo, mask, readScannable } from './secrets.ts';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text with every comment line (starting with //, /* or *) emptied, so line numbers hold. */
export function withoutComments(src: string): string[] {
  return src.split('\n').map((line) => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? '' : line));
}

// ---- g1: an amount from the request body ----

const STRIPE_CREATE = /\.\s*(?:checkout\s*\.\s*sessions|paymentIntents|prices)\s*\.\s*create\s*\(/;
const BODY_SOURCE = /\.json\(|\.text\(|\.body\b/;
const AMOUNT_PROPERTY = /(?:^|[{,])\s*["']?(unit_amount_decimal|unit_amount|amount)["']?\s*:/g;
const NUMBER_NAMES = /\b(?:Number|parseInt|parseFloat|Math\s*\.\s*(?:round|floor|ceil|trunc))\b/g;
const ONLY_ARITHMETIC = /^[\s().,\d+\-*/?|]*$/;

/** The local names a destructuring pattern binds: `{ price, service: name, qty = 1 }` gives price, name, qty. */
function boundNames(pattern: string): string[] {
  const names: string[] = [];
  for (const entry of pattern.split(',')) {
    const renamed = entry.replace(/^\s*\.\.\./, '').split(':').pop()!;
    const name = renamed.split('=')[0]!.trim();
    if (IDENTIFIER.test(name)) names.push(name);
  }
  return names;
}

interface BodyNames {
  objects: Set<string>;
  values: Set<string>;
}

function collectBodyNames(lines: string[]): BodyNames {
  const objects = new Set(['req.body', 'request.body']);
  const values = new Set<string>();
  const declarations = lines.flatMap((line) => {
    const match = /\b(?:const|let|var)\s+(?:(\{[^}]*\})|([A-Za-z_$][\w$]*))\s*(?::[^=]+)?=\s*(.*)$/.exec(line);
    return match ? [{ pattern: match[1], name: match[2], rhs: match[3]! }] : [];
  });
  for (const { pattern, name, rhs } of declarations) {
    if (!BODY_SOURCE.test(rhs)) continue;
    if (name) objects.add(name);
    else if (pattern) for (const bound of boundNames(pattern.slice(1, -1))) values.add(bound);
  }
  for (const { pattern, rhs } of declarations) {
    if (pattern && objects.has(rhs.trim().replace(/;$/, '').trim())) {
      for (const bound of boundNames(pattern.slice(1, -1))) values.add(bound);
    }
  }
  return { objects, values };
}

function referenceRegExp({ objects, values }: BodyNames): RegExp {
  const parts = [
    ...[...objects].map((name) => `${escapeRegExp(name)}(?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*|\\s*\\[\\s*["'][^"']+["']\\s*\\])+`),
    ...[...values].map((name) => `${escapeRegExp(name)}(?![\\w$])`),
  ];
  return new RegExp(`(?<![\\w$.])(?:${parts.join('|')})`, 'g');
}

/** The value of a property: the text up to the first , or } outside parentheses, or the line's end. */
function propertyValue(rest: string): string {
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const char = rest[i];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth <= 0 && (char === ',' || char === '}')) return rest.slice(0, i);
  }
  return rest;
}

/** 1-based lines that give Stripe an amount built from the request body. */
export function trustedAmountLines(src: string): number[] {
  const lines = withoutComments(src);
  if (!STRIPE_CREATE.test(lines.join('\n'))) return [];
  const references = referenceRegExp(collectBodyNames(lines));
  const flagged: number[] = [];
  lines.forEach((line, i) => {
    for (const property of line.matchAll(AMOUNT_PROPERTY)) {
      const value = propertyValue(line.slice(property.index + property[0].length)).replace(/\/\/.*$/, '');
      const rest = value.replace(references, '');
      if (rest === value) continue;
      if (ONLY_ARITHMETIC.test(rest.replace(NUMBER_NAMES, ''))) {
        flagged.push(i + 1);
        break;
      }
    }
  });
  return flagged;
}

// ---- g2: a webhook handler that never verifies the signature ----

const EVENT_TYPE = /['"`](?:checkout\.session|payment_intent|charge|invoice|customer\.subscription)\.[a-z_]+(?:\.[a-z_]+)*['"`]/;
const BODY_READ = /\.(?:json|text|arrayBuffer)\s*\(\s*\)|\b(?:req|request)\.body\b/;
const SIGNATURE_CHECK = /\.webhooks\s*\.\s*constructEvent(?:Async)?\s*\(/;

/** The 1-based line of the first request-body read in an unverified Stripe webhook handler. */
export function unverifiedWebhookLine(src: string): number | undefined {
  const lines = withoutComments(src);
  const text = lines.join('\n');
  if (!EVENT_TYPE.test(text) || SIGNATURE_CHECK.test(text)) return undefined;
  const index = lines.findIndex((line) => BODY_READ.test(line));
  return index === -1 ? undefined : index + 1;
}

// ---- g3: a test publishable key in a production env file ----

/** `.env.production`, `.env.prod` and those with a further suffix, in any folder. */
export function isProductionEnvFile(file: string): boolean {
  return /^\.env\.prod(?:uction)?(?:\..+)?$/.test(path.posix.basename(file));
}

export function findTestPublishableKeys(line: string): string[] {
  return [...line.matchAll(/\bpk_test_[A-Za-z0-9]{16,}/g)].map((match) => match[0]);
}

// ---- findings ----

const AMOUNT_SNIPPET = `const { bookingId } = await req.json();
const booking = await loadBooking(bookingId); // read on the server
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  line_items: [{
    quantity: 1,
    price_data: {
      currency: 'eur',
      product_data: { name: booking.service },
      unit_amount: PRICES[booking.service], // the server's price, never the request's
    },
  }],
  client_reference_id: booking.id,
  success_url: \`\${origin}/paid\`,
  cancel_url: \`\${origin}/\`,
});`;

const WEBHOOK_SNIPPET = `const signature = req.headers.get('stripe-signature') ?? '';
const body = await req.text(); // the raw body: parsing it first breaks the signature
let event: Stripe.Event;
try {
  event = await stripe.webhooks.constructEventAsync(
    body, signature, Deno.env.get('STRIPE_WEBHOOK_SECRET')!, undefined, Stripe.createSubtleCryptoProvider(),
  );
} catch {
  return new Response('Invalid signature', { status: 400 });
}`;

function amountFinding(file: string, line: number): Finding {
  return {
    check: 'g',
    severity: 'critical',
    title: 'Stripe charges an amount the browser sent',
    location: { file, line },
    why: "The amount on this line comes from the request body, which the visitor's browser sends and anyone can change. A customer can pay 1 EUR for a 100 EUR booking, and Stripe reports the payment as complete.",
    fix: {
      text: 'Send only what is being bought from the browser, such as the booking or product id, and look the price up on the server, from your database or a price list in the server code. Never take the amount from the request.',
      snippet: { language: 'ts', code: AMOUNT_SNIPPET },
    },
    checkBefore:
      'Whether the server already checks this amount against the real price before this line, for example by refusing a request whose amount differs from the price in your database; if it does, this finding does not apply. Also find every page that calls this endpoint: after the fix they send the booking or product id instead of a price.',
  };
}

function webhookFinding(file: string, line: number): Finding {
  return {
    check: 'g',
    severity: 'critical',
    title: "Stripe webhook handler does not verify Stripe's signature",
    location: { file, line },
    why: 'This file acts on Stripe events, such as a completed checkout, but never calls stripe.webhooks.constructEvent or constructEventAsync, which checks the Stripe-Signature header. Anyone who finds the URL can post a fake "paid" event, and the booking or order is marked as paid without a payment.',
    fix: {
      text: "Read the raw request body and build the event with stripe.webhooks.constructEventAsync (constructEvent in Node), with this endpoint's signing secret from the Stripe Dashboard kept in a server-side secret. Answer 400 when it throws, and act only on the event it returns.",
      snippet: { language: 'ts', code: WEBHOOK_SNIPPET },
    },
    checkBefore:
      "Whether this file receives the request from Stripe itself. If another file verifies the signature and passes the verified event on to this one, this finding does not apply. Set the endpoint's signing secret (whsec_…) in the server's secrets before deploying the fix, or every real event is refused.",
  };
}

function testKeyFinding(file: string, key: string, line: number): Finding {
  return {
    check: 'g',
    severity: 'high',
    title: `Stripe test publishable key ${mask(key)} in a production env file`,
    location: { file, line },
    why: `${file} configures the production build, and it sets a Stripe test-mode key. In test mode the checkout looks normal but no real money moves, so customers' bookings or orders go through unpaid.`,
    fix: {
      text: "Replace it with the live publishable key (pk_live_…) from the Stripe Dashboard, Developers, API keys, with test mode off. The server's secret key and webhook signing secret must be the live ones too.",
    },
    checkBefore:
      'Whether this file really configures the live app. If this deploy is meant to run in test mode, such as a staging site, this finding does not apply. Switch the server\'s Stripe secret key and webhook signing secret to live at the same time, or payments fail.',
  };
}

export const paymentsCheck: Check = {
  id: 'g',
  async run({ repoPath }) {
    // The same files as check d: what git tracks under the path, or every file outside a repo.
    const repo = await inGitRepo(repoPath);
    const files = repo
      ? (await git(repoPath, ['-c', 'core.quotePath=false', 'ls-files', '-z'])).split('\0').filter(Boolean).sort()
      : await walkFiles(repoPath);

    const findings: Finding[] = [];
    for (const file of files) {
      const isSource = SOURCE_EXTENSIONS.has(path.posix.extname(file));
      const isEnv = isProductionEnvFile(file);
      if (!isSource && !isEnv) continue;
      const text = await readScannable(path.join(repoPath, file));
      if (text === undefined) continue;

      if (isSource) {
        for (const line of trustedAmountLines(text)) findings.push(amountFinding(file, line));
        const webhookLine = unverifiedWebhookLine(text);
        if (webhookLine !== undefined) findings.push(webhookFinding(file, webhookLine));
      }
      if (isEnv) {
        const seen = new Set<string>();
        text.split('\n').forEach((line, i) => {
          for (const key of findTestPublishableKeys(line)) {
            if (seen.has(key)) continue;
            seen.add(key);
            findings.push(testKeyFinding(file, key, i + 1));
          }
        });
      }
    }
    return findings;
  },
};
