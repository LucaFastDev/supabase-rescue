import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabaseAdmin } from "@/integrations/supabase/admin";
import type { Customer } from "@/lib/types";

const Customers = () => {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The admin client reads every customer, whatever the policies say.
    supabaseAdmin
      .from("customers")
      .select("id, full_name, phone, email, created_at")
      .order("full_name")
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setCustomers((data ?? []) as Customer[]);
      });
  }, []);

  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Customers</h1>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Email</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {customers.map((customer) => (
            <TableRow key={customer.id}>
              <TableCell>
                <Link className="underline-offset-4 hover:underline" to={`/customers/${customer.id}`}>
                  {customer.full_name}
                </Link>
              </TableCell>
              <TableCell>{customer.phone}</TableCell>
              <TableCell>{customer.email ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

export default Customers;
