import { useEffect, useState, type ChangeEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { formatDateTime, type Appointment, type Customer } from "@/lib/types";

const PHOTOS = "customer-photos";

const CustomerDetail = () => {
  const { id } = useParams<{ id: string }>();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [photos, setPhotos] = useState<string[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPhotos = async (customerId: string) => {
    const { data, error } = await supabase.storage.from(PHOTOS).list(customerId);
    if (error) {
      setError(error.message);
      return;
    }
    // Folders come back with no id; only files are photos.
    const files = (data ?? []).filter((item) => item.id !== null);
    setPhotos(files.map((file) => supabase.storage.from(PHOTOS).getPublicUrl(`${customerId}/${file.name}`).data.publicUrl));
  };

  const addPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!id || !file) return;
    setPhotoError(null);
    const { error } = await supabase.storage.from(PHOTOS).upload(`${id}/${crypto.randomUUID()}-${file.name}`, file);
    input.value = "";
    if (error) {
      setPhotoError("The photo could not be added.");
      return;
    }
    loadPhotos(id);
  };

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
    loadPhotos(id);
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
      <div className="grid gap-2">
        <h2 className="text-lg font-semibold">Photos</h2>
        <div className="grid gap-1 justify-self-start">
          <Label htmlFor="add-photo">Add photo</Label>
          <Input id="add-photo" type="file" accept="image/*" onChange={addPhoto} />
        </div>
        {photoError && <p className="text-sm text-destructive">{photoError}</p>}
        {photos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No photos yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {photos.map((url) => (
              <img key={url} src={url} alt="Customer photo" className="h-32 w-32 rounded-md object-cover" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default CustomerDetail;
