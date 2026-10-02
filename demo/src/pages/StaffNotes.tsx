import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { formatDateTime, type StaffNote } from "@/lib/types";

const StaffNotes = () => {
  const { id } = useParams<{ id: string }>();
  const [customerName, setCustomerName] = useState("");
  const [notes, setNotes] = useState<StaffNote[]>([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async (customerId: string) => {
    const { data, error } = await supabase
      .from("staff_notes")
      .select("id, customer_id, body, created_at, staff(display_name)")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false });
    if (error) setError(error.message);
    else setNotes((data ?? []) as unknown as StaffNote[]);
  };

  useEffect(() => {
    if (!id) return;
    supabase
      .from("customers")
      .select("full_name")
      .eq("id", id)
      .single()
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setCustomerName((data as { full_name: string }).full_name);
      });
    load(id);
  }, [id]);

  const addNote = async (event: FormEvent) => {
    event.preventDefault();
    if (!id || !body.trim()) return;
    const { error } = await supabase.from("staff_notes").insert({ customer_id: id, body: body.trim() });
    if (error) {
      setError(error.message);
      return;
    }
    setBody("");
    load(id);
  };

  return (
    <div className="grid gap-6">
      <div>
        <Link className="text-sm text-muted-foreground hover:underline" to={`/customers/${id}`}>
          ← {customerName || "Customer"}
        </Link>
        <h1 className="text-2xl font-semibold">Staff notes</h1>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <form className="grid gap-2" onSubmit={addNote}>
        <Textarea
          aria-label="New note"
          placeholder="Formulas, preferences, allergies…"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <Button type="submit" className="justify-self-start">
          Add note
        </Button>
      </form>
      <div className="grid gap-3">
        {notes.map((note) => (
          <Card key={note.id} className="gap-2 py-4">
            <CardHeader className="px-4">
              <CardDescription>
                {note.staff?.display_name ?? "Staff"}, {formatDateTime(note.created_at)}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-4 text-sm">{note.body}</CardContent>
          </Card>
        ))}
        {notes.length === 0 && <p className="text-sm text-muted-foreground">No notes yet.</p>}
      </div>
    </div>
  );
};

export default StaffNotes;
