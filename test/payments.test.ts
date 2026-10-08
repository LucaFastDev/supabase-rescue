import { describe, expect, it } from 'vitest';
import { findTestPublishableKeys, isProductionEnvFile, paymentsCheck, trustedAmountLines, unverifiedWebhookLine } from '../src/checks/payments.ts';
import type { Finding } from '../src/findings.ts';
import { FAKE, STRIPE_PUBLISHABLE, commitAll, git, gitRepo, tempDir, writeFiles } from './repo.ts';

const run = async (repoPath: string) => paymentsCheck.run({ repoPath, exposedSchemas: ['public'] });
const where = (f: Finding) => ('file' in f.location ? `${f.location.file}:${f.location.line}` : f.location.object);
const summary = (findings: Finding[]) => findings.map((f) => `${f.severity ?? f.kind} ${where(f)}`).sort();

/** A source text with `declarations`, then a checkout create call holding `property` on its own line. */
const checkout = (declarations: string[], property: string) =>
  [...declarations, 'const session = await stripe.checkout.sessions.create({', `  ${property}`, '});'].join('\n');

describe('trustedAmountLines', () => {
  const fromJson = ['const body = await req.json();'];
  it.each([
    { name: 'a body property', declarations: fromJson, property: 'unit_amount: body.price,' },
    { name: 'a destructured body value', declarations: ['const { price } = await req.json();'], property: 'unit_amount: price,' },
    { name: 'a destructured value with a rename and a default', declarations: ['const { price, service: name, qty = 1 } = await req.json();'], property: 'unit_amount: name,' },
    { name: 'a default-valued destructured name', declarations: ['const { price, qty = 1 } = await req.json();'], property: 'unit_amount: qty * 100,' },
    { name: 'arithmetic on a body property', declarations: fromJson, property: 'amount: Math.round(body.total * 100),' },
    { name: 'a converted req.body property', declarations: [], property: 'unit_amount: Number(req.body.price),' },
    { name: 'a parsed destructured value', declarations: ['const { price } = await req.json();'], property: 'unit_amount: parseInt(price, 10),' },
    { name: 'a body property with a fallback', declarations: fromJson, property: 'amount: body.amount ?? 0,' },
    { name: 'a nested body property', declarations: fromJson, property: 'unit_amount: body.item.price,' },
    { name: 'a bracket access', declarations: fromJson, property: 'unit_amount: body["price"],' },
    { name: 'unit_amount_decimal', declarations: fromJson, property: 'unit_amount_decimal: body.price,' },
    { name: 'a parsed text body', declarations: ['const payload = JSON.parse(await req.text());'], property: 'amount: payload.amount,' },
    { name: 'a destructuring of the body object', declarations: [...fromJson, 'const { price } = body;'], property: 'unit_amount: price,' },
    { name: 'an amount inside a one-line object', declarations: fromJson, property: 'price_data: { currency: "gbp", unit_amount: body.price },' },
  ])('flags $name', ({ declarations, property }) => {
    expect(trustedAmountLines(checkout(declarations, property))).toEqual([declarations.length + 2]);
  });

  it.each([
    { name: 'a server-side lookup keyed by the body', declarations: fromJson, property: 'unit_amount: PRICES[body.service],' },
    { name: 'a value loaded on the server', declarations: ['const booking = await loadBooking(id);'], property: 'unit_amount: booking.price,' },
    { name: 'a lookup function called with a body value', declarations: fromJson, property: 'unit_amount: lookupPrice(body.id),' },
    { name: 'a constant', declarations: fromJson, property: 'unit_amount: 4500,' },
    { name: 'a price id, which is not an amount', declarations: fromJson, property: 'price: body.priceId,' },
    { name: 'a property of something else with a body value’s name', declarations: ['const { price } = await req.json();'], property: 'unit_amount: booking.price,' },
    { name: 'a ternary that mentions amount', declarations: fromJson, property: 'x: ok ? amount : body.price,' },
  ])('does not flag $name', ({ declarations, property }) => {
    expect(trustedAmountLines(checkout(declarations, property))).toEqual([]);
  });

  it('flags each line, one finding per line', () => {
    const src = ['const body = await req.json();', 'stripe.checkout.sessions.create({', '  unit_amount: body.a,', '  amount: body.b,', '});'].join('\n');
    expect(trustedAmountLines(src)).toEqual([3, 4]);
  });

  it('flags a body amount in paymentIntents.create', () => {
    const src = ['const { price } = await req.json();', 'const intent = await stripe.paymentIntents.create({', '  amount: price,', '  currency: "gbp",', '});'].join('\n');
    expect(trustedAmountLines(src)).toEqual([3]);
  });

  it('flags a body amount in prices.create', () => {
    const src = ['const body = await req.json();', 'await stripe', '  .prices.create({', '    unit_amount: body.price,', '  });'].join('\n');
    expect(trustedAmountLines(src)).toEqual([4]);
  });

  it('gives nothing for an amount in a file with no Stripe create call', () => {
    expect(trustedAmountLines('const body = await req.json();\nconst line = {\n  unit_amount: body.price,\n};')).toEqual([]);
  });

  it('skips a commented-out amount', () => {
    expect(trustedAmountLines(checkout(['const body = await req.json();'], '// unit_amount: body.price,'))).toEqual([]);
  });

  it.each(['', '\0\0', '}{)(', 'const { = ', 'stripe.prices.create({ amount: [', 'const x = req.body\n'.repeat(3)])('does not throw on odd text %j', (text) => {
    expect(() => trustedAmountLines(text)).not.toThrow();
    expect(() => unverifiedWebhookLine(text)).not.toThrow();
  });
});

describe('unverifiedWebhookLine', () => {
  it('gives the first request-body read of an unverified handler', () => {
    const src = ['Deno.serve(async (req) => {', '  const event = await req.json();', '  if (event.type === "checkout.session.completed") {}', '});'].join('\n');
    expect(unverifiedWebhookLine(src)).toBe(2);
  });

  it('handles an Express-style handler that reads req.body', () => {
    const src = ["app.post('/hook', (req, res) => {", '  const event = req.body;', "  switch (event.type) { case 'payment_intent.succeeded': break; }", '});'].join('\n');
    expect(unverifiedWebhookLine(src)).toBe(2);
  });

  it('is undefined when constructEventAsync verifies', () => {
    const src = ['const body = await req.text();', 'const event = await stripe.webhooks.constructEventAsync(body, sig, secret);', 'if (event.type === "checkout.session.completed") {}'].join('\n');
    expect(unverifiedWebhookLine(src)).toBeUndefined();
  });

  it('is undefined when constructEvent verifies', () => {
    const src = ['const event = stripe.webhooks.constructEvent(req.body, sig, secret);', "if (event.type === 'invoice.paid') {}"].join('\n');
    expect(unverifiedWebhookLine(src)).toBeUndefined();
  });

  it('is undefined with an event type but no request-body read', () => {
    expect(unverifiedWebhookLine('export const handle = (event) => event.type === "checkout.session.completed";')).toBeUndefined();
  });

  it('is undefined with a body read but no Stripe event type', () => {
    expect(unverifiedWebhookLine('const body = await req.json();')).toBeUndefined();
  });

  it('ignores a body read in a comment', () => {
    expect(unverifiedWebhookLine('// const event = await req.json();\nconst t = "checkout.session.completed";')).toBeUndefined();
  });
});

describe('isProductionEnvFile', () => {
  it.each(['.env.production', '.env.prod', '.env.production.local', 'web/.env.production', 'a/b/.env.prod.local'])('is true for %s', (file) => {
    expect(isProductionEnvFile(file)).toBe(true);
  });

  it.each(['.env', '.env.local', '.env.development', '.env.staging', '.env.example', 'env.production', '.env.products', 'src/production.ts'])('is false for %s', (file) => {
    expect(isProductionEnvFile(file)).toBe(false);
  });
});

describe('findTestPublishableKeys', () => {
  it('finds every test publishable key on a line, and never a live or secret key', () => {
    const other = 'pk_' + 'test_' + 'Zz9Zz9Zz9Zz9Zz9Zz9Zz9';
    expect(findTestPublishableKeys(`A=${STRIPE_PUBLISHABLE.test} B=${other}`)).toEqual([STRIPE_PUBLISHABLE.test, other]);
    expect(findTestPublishableKeys(`A=${STRIPE_PUBLISHABLE.live} B=${FAKE.stripeTest} C=${FAKE.stripeLive}`)).toEqual([]);
  });
});

// The demo's checkout, as it is on main: the price comes from the browser.
const FLAWED_CHECKOUT = [
  'import Stripe from "npm:stripe@23";',
  'const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);',
  'Deno.serve(async (req) => {',
  '  const body = await req.json();',
  '  const session = await stripe.checkout.sessions.create({',
  '    mode: "payment",',
  '    line_items: [{',
  '      quantity: 1,',
  '      price_data: {',
  '        currency: "gbp",',
  '        product_data: { name: body.service },',
  '        unit_amount: body.price,',
  '      },',
  '    }],',
  '    client_reference_id: body.appointmentId,',
  '  });',
  '  return Response.json({ url: session.url });',
  '});',
].join('\n');

// The same function with the price looked up on the server: the fixed state check g finds nothing in.
const FIXED_CHECKOUT = [
  'import Stripe from "npm:stripe@23";',
  'import { createClient } from "npm:@supabase/supabase-js@2";',
  'const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);',
  'const SERVICE_PRICES = { "Cut and finish": 4500, "Blow-dry": 3000 };',
  'Deno.serve(async (req) => {',
  '  const { appointmentId } = await req.json();',
  '  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);',
  '  const { data: appointment } = await admin.from("appointments").select("id, service").eq("id", appointmentId).single();',
  '  const session = await stripe.checkout.sessions.create({',
  '    mode: "payment",',
  '    line_items: [{',
  '      quantity: 1,',
  '      price_data: {',
  '        currency: "gbp",',
  '        product_data: { name: appointment.service },',
  '        unit_amount: SERVICE_PRICES[appointment.service],',
  '      },',
  '    }],',
  '    client_reference_id: appointment.id,',
  '  });',
  '  return Response.json({ url: session.url });',
  '});',
].join('\n');

const VERIFIED_WEBHOOK = [
  'Deno.serve(async (req) => {',
  '  const signature = req.headers.get("stripe-signature");',
  '  const body = await req.text();',
  '  const event = await stripe.webhooks.constructEventAsync(body, signature ?? "", secret, undefined, provider);',
  '  if (event.type === "checkout.session.completed") {}',
  '});',
].join('\n');

const UNVERIFIED_WEBHOOK = [
  'Deno.serve(async (req) => {',
  '  const event = await req.json();',
  '  if (event.type === "checkout.session.completed") {}',
  '});',
].join('\n');

describe('paymentsCheck', () => {
  it("has the id 'g'", () => {
    expect(paymentsCheck.id).toBe('g');
  });

  it('g1 triggers: a checkout that charges the amount the browser sent is one critical at the unit_amount line', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'supabase/functions/checkout/index.ts': FLAWED_CHECKOUT });
    const findings = await run(root);
    const line = FLAWED_CHECKOUT.split('\n').findIndex((l) => l.includes('unit_amount: body.price')) + 1;
    expect(summary(findings)).toEqual([`critical supabase/functions/checkout/index.ts:${line}`]);
    expect(findings[0]).toMatchObject({
      check: 'g',
      title: 'Stripe charges an amount the browser sent',
      owner: 'A customer can pay €1 for a €100 booking.',
    });
    expect(findings[0]!.checkBefore).not.toBe('');
  });

  it("g1 does not trigger: the demo's checkout with the price looked up on the server finds nothing", async () => {
    const root = await tempDir();
    await writeFiles(root, { 'supabase/functions/checkout/index.ts': FIXED_CHECKOUT });
    expect(await run(root)).toEqual([]);
  });

  it('g2 triggers: a handler that never verifies the signature is one critical at its body read', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'supabase/functions/hook/index.ts': UNVERIFIED_WEBHOOK });
    const findings = await run(root);
    expect(summary(findings)).toEqual(['critical supabase/functions/hook/index.ts:2']);
    expect(findings[0]).toMatchObject({
      check: 'g',
      title: "Stripe webhook handler does not verify Stripe's signature",
      owner: 'Anyone can mark an order as paid without paying.',
    });
  });

  it('g2 does not trigger: a handler that calls constructEventAsync finds nothing', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'supabase/functions/hook/index.ts': VERIFIED_WEBHOOK });
    expect(await run(root)).toEqual([]);
  });

  it('reads only source files for g1 and g2', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'notes.md': UNVERIFIED_WEBHOOK, 'hook.txt': FLAWED_CHECKOUT });
    expect(await run(root)).toEqual([]);
  });

  it('g3 triggers: a test publishable key in .env.production is one high, and the full key is in no field', async () => {
    const root = await tempDir();
    await writeFiles(root, { '.env.production': `VITE_X=1\nVITE_STRIPE_PUBLISHABLE_KEY=${STRIPE_PUBLISHABLE.test}\n` });
    const findings = await run(root);
    expect(summary(findings)).toEqual(['high .env.production:2']);
    expect(findings[0]!.title).toContain('…');
    expect(findings[0]!.owner).toBe('Your live checkout uses a Stripe test key, so it takes no real money.');
    expect(JSON.stringify(findings)).not.toContain(STRIPE_PUBLISHABLE.test);
  });

  it('g3 gives one finding for a key that appears twice in a file', async () => {
    const root = await tempDir();
    await writeFiles(root, { '.env.production': `A=${STRIPE_PUBLISHABLE.test}\nB=${STRIPE_PUBLISHABLE.test}\n` });
    expect(summary(await run(root))).toEqual(['high .env.production:1']);
  });

  it('g3 does not trigger in .env, .env.local or .env.development', async () => {
    const root = await tempDir();
    const content = `KEY=${STRIPE_PUBLISHABLE.test}\n`;
    await writeFiles(root, { '.env': content, '.env.local': content, '.env.development': content });
    expect(await run(root)).toEqual([]);
  });

  it('g3 does not trigger on a live publishable key, and leaves a secret test key to check d', async () => {
    const root = await tempDir();
    await writeFiles(root, { '.env.production': `A=${STRIPE_PUBLISHABLE.live}\nB=${FAKE.stripeTest}\n` });
    expect(await run(root)).toEqual([]);
  });

  it('in a git repo reads only tracked files: an untracked .env.production gives nothing, the committed one a high', async () => {
    const root = await gitRepo();
    await writeFiles(root, { 'README.md': 'x', '.env.production': `KEY=${STRIPE_PUBLISHABLE.test}\n` });
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'readme only');
    expect(await run(root)).toEqual([]);
    commitAll(root, 'track env');
    expect(summary(await run(root))).toEqual(['high .env.production:1']);
  });
});
