import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { SERVICES, formatDateTime } from "@/lib/types";

interface UpcomingBooking {
  starts_at: string;
  service: string;
  status: string;
}

const Book = () => {
  const [signedIn, setSignedIn] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lookupPhone, setLookupPhone] = useState("");
  const [bookings, setBookings] = useState<UpcomingBooking[] | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSignedIn(data.session !== null));
  }, []);

  const book = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSubmitting(true);
    setMessage(null);
    const { error } = await supabase.from("appointments").insert({
      customer_name: String(form.get("name")),
      customer_phone: String(form.get("phone")),
      customer_email: String(form.get("email")) || null,
      service: String(form.get("service")),
      starts_at: new Date(`${form.get("date")}T${form.get("time")}`).toISOString(),
    });
    setSubmitting(false);
    if (error) {
      setMessage(`Sorry, that did not work: ${error.message}`);
      return;
    }
    formElement.reset();
    setMessage("Thank you! Your appointment is booked. We will confirm it by phone.");
  };

  const findBookings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLookupError(null);
    const { data, error } = await supabase.rpc("appointments_for_phone", { phone_number: lookupPhone });
    if (error) {
      setBookings(null);
      setLookupError(`Sorry, we could not look that up: ${error.message}`);
      return;
    }
    setBookings((data ?? []) as UpcomingBooking[]);
  };

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <span className="font-semibold">Juniper &amp; Ash Hair Studio</span>
          <Button asChild variant="ghost" size="sm">
            <Link to={signedIn ? "/appointments" : "/login"}>{signedIn ? "Staff area" : "Staff sign in"}</Link>
          </Button>
        </div>
      </header>
      <main className="mx-auto grid max-w-3xl gap-6 px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Book an appointment</CardTitle>
            <CardDescription>Pick a service and a time. We are open Monday to Saturday, 9:00 to 18:00.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={book}>
              <div className="grid gap-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" name="phone" type="tel" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">Email (optional)</Label>
                <Input id="email" name="email" type="email" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="service">Service</Label>
                <select
                  id="service"
                  name="service"
                  className="border-input h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs"
                  required
                >
                  {SERVICES.map((service) => (
                    <option key={service}>{service}</option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="date">Date</Label>
                <Input id="date" name="date" type="date" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="time">Time</Label>
                <Input id="time" name="time" type="time" min="09:00" max="18:00" step="1800" required />
              </div>
              <div className="flex items-center gap-4 sm:col-span-2">
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Booking…" : "Book"}
                </Button>
                {message && <p className="text-sm text-muted-foreground">{message}</p>}
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Find my booking</CardTitle>
            <CardDescription>Enter the phone number you booked with to see your upcoming appointments.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <form className="flex gap-2" onSubmit={findBookings}>
              <Input
                aria-label="Phone"
                type="tel"
                value={lookupPhone}
                onChange={(event) => setLookupPhone(event.target.value)}
                required
              />
              <Button type="submit" variant="secondary">
                Find
              </Button>
            </form>
            {lookupError && <p className="text-sm text-destructive">{lookupError}</p>}
            {bookings !== null &&
              (bookings.length === 0 ? (
                <p className="text-sm text-muted-foreground">No upcoming appointments for that number.</p>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {bookings.map((booking) => (
                    <li key={booking.starts_at}>
                      {formatDateTime(booking.starts_at)}: {booking.service} ({booking.status})
                    </li>
                  ))}
                </ul>
              ))}
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default Book;
