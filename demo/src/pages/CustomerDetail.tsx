import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { formatDateTime, type Appointment, type Customer } from "@/lib/types";

const CustomerDetail = () => {
  const { id } = useParams<{ id: string }>();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    supabase
      .from("customers")
      .select("id, full_name, phone, email, created_at")
      .eq("id", id)
      .single()
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setCustomer(data as Customer);
      });
    supabase
      .from("appointments")
      .select("*")
      .eq("customer_id", id)
      .order("starts_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setAppointments((data ?? []) as Appointment[]);
      });
  }, [id]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!customer) return null;

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{customer.full_name}</h1>
        <Button asChild variant="outline">
          <Link to={`/customers/${customer.id}/notes`}>Staff notes</Link>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Contact</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm">
          <p>Phone: {customer.phone}</p>
          <p>Email: {customer.email ?? "—"}</p>
          <p>Customer since {new Date(customer.created_at).toLocaleDateString("en-GB")}</p>
        </CardContent>
      </Card>
      <div className="grid gap-2">
        <h2 className="text-lg font-semibold">Appointments</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Service</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {appointments.map((appointment) => (
              <TableRow key={appointment.id}>
                <TableCell>{formatDateTime(appointment.starts_at)}</TableCell>
                <TableCell>{appointment.service}</TableCell>
                <TableCell>
                  <Badge variant={appointment.status === "cancelled" ? "destructive" : "secondary"}>
                    {appointment.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};

export default CustomerDetail;
