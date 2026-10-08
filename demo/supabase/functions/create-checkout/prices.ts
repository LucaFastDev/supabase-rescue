// What each service costs, in pence: the prices checkout charges. They match SERVICE_PRICES in
// src/lib/types.ts, which the booking page shows; the browser never sends a price.
export const SERVICE_PRICES: Record<string, number> = {
  "Cut and finish": 4500,
  "Blow-dry": 3000,
  Colour: 7500,
  Balayage: 12000,
  "Beard trim": 1500,
  "Kids cut": 2000,
};
