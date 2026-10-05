import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";

interface WeekCount {
  week: string;
  count: number;
}

/** Monday of the week the date falls in, as YYYY-MM-DD in local time. */
function weekStart(iso: string): string {
  const date = new Date(iso);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const Reports = () => {
  const [weeks, setWeeks] = useState<WeekCount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarising, setSummarising] = useState(false);

  useEffect(() => {
    supabase
      .from("appointments")
      .select("starts_at")
      .neq("status", "cancelled")
      .then(({ data, error }) => {
        if (error) {
          setError(error.message);
          return;
        }
        const counts = new Map<string, number>();
        for (const row of (data ?? []) as { starts_at: string }[]) {
          const week = weekStart(row.starts_at);
          counts.set(week, (counts.get(week) ?? 0) + 1);
        }
        setWeeks(
          [...counts.entries()]
            .map(([week, count]) => ({ week, count }))
            .sort((a, b) => a.week.localeCompare(b.week)),
        );
      });
  }, []);

  const summarise = async () => {
    setSummarising(true);
    setError(null);
    const { data, error } = await supabase.functions.invoke("summarise-weeks", { body: { weeks } });
    setSummarising(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSummary(data.summary);
  };

  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Reports</h1>
      <p className="text-sm text-muted-foreground">Appointments per week, not counting cancellations.</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Week of</TableHead>
            <TableHead className="text-right">Appointments</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {weeks.map(({ week, count }) => (
            <TableRow key={week}>
              <TableCell>{new Date(`${week}T00:00:00`).toLocaleDateString("en-GB", { dateStyle: "medium" })}</TableCell>
              <TableCell className="text-right">{count}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Button disabled={weeks.length === 0 || summarising} onClick={summarise} className="justify-self-start">
        Summarise with AI
      </Button>
      {summary && <p className="text-sm">{summary}</p>}
    </div>
  );
};

export default Reports;
