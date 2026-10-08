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
  /** The access token Auth knows as a signed-in user who has a row in public.staff. */
  staffToken: 'signed-in-staff-token',
  /** The access token Auth knows as a signed-in user with no staff row, as anyone who signs up is. */
  strangerToken: 'signed-in-stranger-token',
  /** The user ids with a row in public.staff. */
  staff: new Set(['staff-user']),
  /** Every lookup in public.staff: the client's key and Authorization header, and the filters it used. */
  staffLookups: [] as { key: string; authorization: string | undefined; filters: Record<string, string> }[],
  /** When set, the lookup in public.staff answers with this error and no data. */
  staffError: null as { message: string } | null,
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
    // As Auth answers: a user for a signed-in user's token, none for the anon key or no token.
    const userId =
      authorization === `Bearer ${fakes.staffToken}` ? 'staff-user' : authorization === `Bearer ${fakes.strangerToken}` ? 'stranger-user' : null;
    return {
      auth: {
        getUser: async () => ({ data: { user: userId ? { id: userId } : null }, error: null }),
      },
      from: (table: string) => {
        const filters: Record<string, string> = {};
        const query = {
          select: () => query,
          eq: (column: string, value: string) => {
            filters[column] = value;
            return query;
          },
          maybeSingle: async () => {
            if (table === 'staff') {
              fakes.staffLookups.push({ key, authorization, filters });
              if (fakes.staffError) return { data: null, error: fakes.staffError };
              // As RLS answers on the caller's token: their own staff row, if they have one, and no one else's.
              const visible = userId !== null && filters.user_id === userId && fakes.staff.has(userId);
              return { data: visible ? { user_id: userId } : null, error: null };
            }
            return { data: table === 'appointments' ? (fakes.appointments.get(filters.id!) ?? null) : null, error: null };
          },
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
    fakes.staffLookups.length = 0;
    fakes.staffError = null;
  });

  const expectStaffOnly = async (response: Response) => {
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Staff only' });
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  };

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

  it('answers 403 to a signed-in user who is not staff, and does not call OpenAI', async () => {
    const response = await handler(post(WEEKS, { Authorization: `Bearer ${fakes.strangerToken}` }));
    await expectStaffOnly(response);
    expect(openai).not.toHaveBeenCalled();
    // It looked for the caller's own staff row with the anon key and the caller's token, not the service-role key.
    expect(fakes.staffLookups).toEqual([
      { key: ENV.SUPABASE_ANON_KEY, authorization: `Bearer ${fakes.strangerToken}`, filters: { user_id: 'stranger-user' } },
    ]);
  });

  it('answers 403 to a staff user when the staff lookup fails, and does not call OpenAI', async () => {
    fakes.staffError = { message: 'connection refused' };
    const response = await handler(post(WEEKS, { Authorization: `Bearer ${fakes.staffToken}` }));
    await expectStaffOnly(response);
    expect(openai).not.toHaveBeenCalled();
  });

  it('summarises for a signed-in user', async () => {
    const response = await handler(post(WEEKS, { Authorization: `Bearer ${fakes.staffToken}` }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: 'A busy fortnight.' });
    expect(openai).toHaveBeenCalledTimes(1);
    expect(String((openai.mock.calls[0] as unknown[])[0])).toBe('https://api.openai.com/v1/chat/completions');
    // The user is staff: it found their row with their own token.
    expect(fakes.staffLookups).toEqual([
      { key: ENV.SUPABASE_ANON_KEY, authorization: `Bearer ${fakes.staffToken}`, filters: { user_id: 'staff-user' } },
    ]);
  });
});
