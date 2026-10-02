import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { STATUSES, bookingReference, formatDateTime, type Appointment, type Status } from "@/lib/types";

const Appointments = () => {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const { data, error } = await supabase
      .from("appointments")
      .select("*")
      .order("starts_at", { ascending: false });
    if (error) setError(error.message);
    else setAppointments((data ?? []) as Appointment[]);
  };

  useEffect(() => {
    load();
  }, []);

  const changeStatus = async (id: string, status: Status) => {
    const { error } = await supabase.from("appointments").update({ status }).eq("id", id);
    if (error) setError(error.message);
    else setAppointments((current) => current.map((a) => (a.id === id ? { ...a, status } : a)));
  };

  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Appointments</h1>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Reference</TableHead>
            <TableHead>When</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Service</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {appointments.map((appointment) => (
            <TableRow key={appointment.id}>
              <TableCell className="font-mono">{bookingReference(appointment.id)}</TableCell>
              <TableCell>{formatDateTime(appointment.starts_at)}</TableCell>
              <TableCell>
                {appointment.customer_id ? (
                  <Link className="underline-offset-4 hover:underline" to={`/customers/${appointment.customer_id}`}>
                    {appointment.customer_name}
                  </Link>
                ) : (
                  appointment.customer_name
                )}
              </TableCell>
              <TableCell>{appointment.customer_phone}</TableCell>
              <TableCell>{appointment.service}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Badge variant={appointment.status === "cancelled" ? "destructive" : "secondary"}>
                    {appointment.status}
                  </Badge>
                  <select
                    aria-label="Change status"
                    className="border-input h-8 rounded-md border bg-transparent px-2 text-sm"
                    value={appointment.status}
                    onChange={(event) => changeStatus(appointment.id, event.target.value as Status)}
                  >
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

export default Appointments;
