export const SERVICES = ["Cut and finish", "Blow-dry", "Colour", "Balayage", "Beard trim", "Kids cut"] as const;

export const STATUSES = ["booked", "confirmed", "completed", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];

export interface Appointment {
  id: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  service: string;
  starts_at: string;
  status: Status;
}

export interface Customer {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  created_at: string;
}

export interface StaffNote {
  id: string;
  customer_id: string;
  body: string;
  created_at: string;
  staff: { display_name: string } | null;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}
