// Runs the demo's create-checkout and summarise-weeks edge functions (demo/supabase/functions/) in
// Node: Deno.serve and Deno.env are stubbed, the Stripe and supabase-js packages they import are
// replaced with fakes that record each call, and fetch, which summarise-weeks calls OpenAI with,
// is a spy. Nothing leaves the machine.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICES, SERVICE_PRICES } from '../demo/src/lib/types.ts';
import { SERVICE_PRICES as SERVER_PRICES } from '../demo/supabase/functions/create-checkout/prices.ts';

type Handler = (req: Request) => Promise<Response>;

const fakes = vi.hoisted(() => ({
  /** The arguments of every stripe.checkout.sessions.create call. */
  checkouts: [] as unknown[],
  /** The appointments the service-role client can read, by id. */
  appointments: new Map<string, { id: string; service: string }>(),
  /** Every createClient call: the key and the Authorization header it was given. */
  clients: [] as { key: string; authorization: string | undefined }[],
  /** The access token Auth knows as a signed-in user. */
  userToken: 'signed-in-staff-token',
}));

vi.mock('npm:stripe@23', () => ({
  default: class {
    checkout = {
      sessions: {
        create: async (params: unknown) => {
          fakes.checkouts.push(params);
          return { url: 'https://checkout.stripe.test/session' };
        },
      },
    };
  },
}));

vi.mock('npm:@supabase/supabase-js@2', () => ({
  createClient: (_url: string, key: string, options?: { global?: { headers?: Record<string, string> } }) => {
    const authorization = options?.global?.headers?.Authorization;
    fakes.clients.push({ key, authorization });
    return {
      // As Auth answers: a user for a signed-in user's token, none for the anon key or no token.
      auth: {
        getUser: async () => ({
          data: { user: authorization === `Bearer ${fakes.userToken}` ? { id: 'staff-user' } : null },
          error: null,
        }),
      },
      from: (table: string) => {
        let id: string | undefined;
        const query = {
          select: () => query,
          eq: (column: string, value: string) => {
            if (column === 'id') id = value;
            return query;
          },
          maybeSingle: async () => ({ data: table === 'appointments' ? (fakes.appointments.get(id!) ?? null) : null, error: null }),
        };
        return query;
      },
    };
  },
}));

const ENV: Record<string, string> = {
  STRIPE_SECRET_KEY: 'sk_test_fake',
  SUPABASE_URL: 'http://127.0.0.1:56321',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  OPENAI_API_KEY: 'openai-fake',
};

const functionsDir = fileURLToPath(new URL('../demo/supabase/functions/', import.meta.url));

/** Imports an edge function's index.ts and returns the handler it gives Deno.serve. */
async function load(name: string): Promise<Handler> {
  let handler: Handler | undefined;
  vi.stubGlobal('Deno', {
    env: { get: (key: string) => ENV[key] },
    serve: (h: Handler) => {
      handler = h;
    },
  });
  await import(pathToFileURL(path.join(functionsDir, name, 'index.ts')).href);
  if (!handler) throw new Error(`${name} did not call Deno.serve`);
  return handler;
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://127.0.0.1:56321/functions/v1/fn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'http://localhost:7173', ...headers },
    body: JSON.stringify(body),
  });

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('create-checkout', () => {
  let handler: Handler;
  const APPOINTMENT = '3f2a9c1e-7b4d-4e2a-9f10-0a1b2c3d4e5f';

  beforeAll(async () => {
    handler = await load('create-checkout');
  });

  beforeEach(() => {
    fakes.checkouts.length = 0;
    fakes.appointments.clear();
    fakes.appointments.set(APPOINTMENT, { id: APPOINTMENT, service: 'Balayage' });
  });

  const charged = () =>
    fakes.checkouts.map((params) => {
      const item = (params as { line_items: { price_data: { unit_amount: unknown; product_data: { name: unknown } } }[] }).line_items[0]!;
      return { name: item.price_data.product_data.name, amount: item.price_data.unit_amount };
    });

  it("charges the server's price for the appointment's service when the request carries a different price", async () => {
    const response = await handler(post({ appointmentId: APPOINTMENT, service: 'Beard trim', price: 1 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://checkout.stripe.test/session' });
    expect(charged()).toEqual([{ name: 'Balayage', amount: 12000 }]);
    expect((fakes.checkouts[0] as { client_reference_id: unknown }).client_reference_id).toBe(APPOINTMENT);
  });

  it("charges the server's price when the request carries no price", async () => {
    const response = await handler(post({ appointmentId: APPOINTMENT }));
    expect(response.status).toBe(200);
    expect(charged()).toEqual([{ name: 'Balayage', amount: 12000 }]);
  });

  it('charges each service what the booking page shows for it', async () => {
    for (const service of SERVICES) {
      fakes.appointments.set(APPOINTMENT, { id: APPOINTMENT, service });
      expect((await handler(post({ appointmentId: APPOINTMENT, price: 1 }))).status, service).toBe(200);
    }
    expect(charged()).toEqual(SERVICES.map((service) => ({ name: service, amount: SERVICE_PRICES[service] })));
    expect(SERVER_PRICES).toEqual(SERVICE_PRICES);
  });

  it('asks Stripe for nothing when the appointment does not exist', async () => {
    const response = await handler(post({ appointmentId: '00000000-0000-4000-8000-000000000000', price: 1 }));
    expect(response.status).toBe(400);
    expect(fakes.checkouts).toEqual([]);
  });
});

describe('summarise-weeks', () => {
  let handler: Handler;
  const openai = vi.fn(async () => Response.json({ choices: [{ message: { content: 'A busy fortnight.' } }] }));

  beforeAll(async () => {
    handler = await load('summarise-weeks');
    vi.stubGlobal('fetch', openai);
  });

  beforeEach(() => {
    openai.mockClear();
    fakes.clients.length = 0;
  });

  const WEEKS = { weeks: [{ week: '2026-10-05', bookings: 12 }] };

  it('answers 401 to a request with only the anon key, and does not call OpenAI', async () => {
    const response = await handler(post(WEEKS, { Authorization: `Bearer ${ENV.SUPABASE_ANON_KEY}`, apikey: ENV.SUPABASE_ANON_KEY! }));
    expect(response.status).toBe(401);
    expect(openai).not.toHaveBeenCalled();
    // It asked Auth about the token the request carried.
    expect(fakes.clients).toContainEqual({ key: ENV.SUPABASE_ANON_KEY, authorization: `Bearer ${ENV.SUPABASE_ANON_KEY}` });
  });

  it('answers 401 to a request with no Authorization header, and does not call OpenAI', async () => {
    const response = await handler(post(WEEKS));
    expect(response.status).toBe(401);
    expect(openai).not.toHaveBeenCalled();
  });

  it('summarises for a signed-in user', async () => {
    const response = await handler(post(WEEKS, { Authorization: `Bearer ${fakes.userToken}` }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: 'A busy fortnight.' });
    expect(openai).toHaveBeenCalledTimes(1);
    expect(String((openai.mock.calls[0] as unknown[])[0])).toBe('https://api.openai.com/v1/chat/completions');
  });
});
