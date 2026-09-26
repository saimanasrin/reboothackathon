// The pitch storyline: one at-risk shipment, taken from detection → explanation → decision → buyer → outcome.
// All numbers are fixed so the role-play is identical on every run. They are prototype / simulated
// outputs, not measured Qatar data.

export const HERO = {
  id: 'SH-2317',
  productId: 'strawberry',
  product: 'Strawberries',
  icon: '🍓',
  qty: 500,
  unit: 'kg',
  plannedDays: 5,
  remainingDays: 2.3,
  confidence: 87,
  risk: 'HIGH',
  issue: 'Temperature excursion detected',
  location: 'Reefer truck QTR-12 · Hamad Port → Doha',
  origin: 'Netherlands · cleared at Hamad Port',

  // Why usable life fell from 5 → 2.3 days. weight = share of the bar.
  factors: [
    { label: 'Temperature excursion', level: 'HIGH', weight: 1.0, detail: '3.2 h at 9.4 °C during transit (ideal 1 °C)' },
    { label: 'Transit delay', level: 'MEDIUM', weight: 0.6, detail: '+6 h waiting at the port' },
    { label: 'Shock event', level: 'MEDIUM', weight: 0.42, detail: '3 drops recorded at loading' },
    { label: 'Humidity', level: 'LOW', weight: 0.2, detail: '86% RH vs 90–95% target' },
  ],
  explanation: 'Temperature exposure during transit accelerated deterioration. A handling event and extended transit further reduced the predicted quality window.',
  agents: [
    { icon: '🔬', name: 'Sensor Analyst', text: 'Detected abnormal temperature + shock pattern.' },
    { icon: '🛡️', name: 'Safety Agent', text: 'No automatic safety violation detected. Safe to sell.' },
    { icon: '🚚', name: 'Decision Agent', text: 'Recommend rapid allocation to high-demand buyers.' },
  ],

  // What happens if the manager does nothing vs. acts.
  whatIf: [
    { action: 'Keep current route', wastePct: 38 },
    { action: 'Reroute', wastePct: 12 },
    { action: 'Reroute + discount', wastePct: 7, best: true },
  ],

  // Where the recommended plan sends it. `buyer: true` is the demo customer account.
  allocation: [
    { qty: 300, to: 'Retailer B', kind: 'Supermarket · Lusail', why: 'High weekly berry sales, sells through in ~1.5 days' },
    { qty: 150, to: 'Corniche Grill', kind: 'Restaurant · West Bay', why: 'Matches their weekly strawberry demand', buyer: true },
    { qty: 50, to: 'Short-life channel', kind: 'Juice & jam processor', why: 'Uses the ripest fruit today' },
  ],
  discountPct: 20,
};

HERO.savedKg = Math.round(HERO.qty * (HERO.whatIf[0].wastePct - HERO.whatIf.at(-1).wastePct) / 100);
HERO.buyerLine = HERO.allocation.find(a => a.buyer);

export const BUYER_EMAIL = 'chef@example.com';

export function freshStory() {
  return { stage: 'alert', run: 1, savedAt: null, orderedAt: null, orderId: null };
}
