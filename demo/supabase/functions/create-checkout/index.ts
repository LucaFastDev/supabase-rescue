import Stripe from "npm:stripe@23";
import { createClient } from "npm:@supabase/supabase-js@2";
import { SERVICE_PRICES } from "./prices.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const failure = (message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Only the appointment comes from the browser: its service and price are read here.
    const { appointmentId } = await req.json();
    const origin = req.headers.get("origin") ?? "";

    // Visitors may not read appointments, so the server reads this one with the service role.
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: appointment, error } = await admin
      .from("appointments")
      .select("id, service")
      .eq("id", appointmentId)
      .maybeSingle();
    if (error) return failure(error.message);
    if (!appointment) return failure("No such appointment");
    const price = SERVICE_PRICES[appointment.service];
    if (price === undefined) return failure("This service cannot be paid for online");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "gbp",
            product_data: { name: appointment.service },
            unit_amount: price,
          },
        },
      ],
      client_reference_id: appointment.id,
      success_url: `${origin}/?paid=1`,
      cancel_url: `${origin}/`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Something went wrong");
  }
});
