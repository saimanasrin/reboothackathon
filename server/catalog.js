// Static reference data: products, storage locations (sensors) and routing rules.
//
// Product parameters drive the kinetic shelf-life model:
//   idealTemp   - storage temperature at which baseShelfH is achieved (°C)
//   maxSafeTemp - above this, time is counted as food-safety "abuse" hours
//   q10         - how many times faster quality is lost per +10 °C
//   rh          - acceptable relative-humidity band (%)
//   chillSensitive - tropical produce that is damaged by storage that is too cold

export const CATEGORIES = [
  { id: 'meat', name: 'Meat & Poultry', icon: '🍗' },
  { id: 'dairy', name: 'Dairy', icon: '🥛' },
  { id: 'vegetables', name: 'Vegetables', icon: '🥬' },
  { id: 'fruits', name: 'Fruits', icon: '🍓' },
];

export const PRODUCTS = [
  // Meat & poultry
  { id: 'chicken', name: 'Fresh chicken breast', category: 'meat', icon: '🍗', unit: 'kg', price: 32, idealTemp: 1, maxSafeTemp: 5, q10: 3.2, rh: [80, 95], baseShelfH: 168, highRisk: true },
  { id: 'lamb', name: 'Chilled lamb leg', category: 'meat', icon: '🍖', unit: 'kg', price: 58, idealTemp: 1, maxSafeTemp: 5, q10: 3.0, rh: [80, 95], baseShelfH: 336, highRisk: true },
  { id: 'beef-mince', name: 'Beef mince', category: 'meat', icon: '🥩', unit: 'kg', price: 45, idealTemp: 1, maxSafeTemp: 5, q10: 3.4, rh: [80, 95], baseShelfH: 96, highRisk: true },
  { id: 'hammour', name: 'Hammour fish (whole)', category: 'meat', icon: '🐟', unit: 'kg', price: 70, idealTemp: 0, maxSafeTemp: 4, q10: 3.6, rh: [85, 98], baseShelfH: 120, highRisk: true },
  // Dairy
  { id: 'milk', name: 'Fresh milk', category: 'dairy', icon: '🥛', unit: 'L', price: 7, idealTemp: 3, maxSafeTemp: 7, q10: 2.6, rh: [60, 95], baseShelfH: 168, highRisk: true },
  { id: 'laban', name: 'Laban', category: 'dairy', icon: '🥤', unit: 'L', price: 6, idealTemp: 3, maxSafeTemp: 8, q10: 2.3, rh: [60, 95], baseShelfH: 336, highRisk: true },
  { id: 'yogurt', name: 'Greek yogurt', category: 'dairy', icon: '🥣', unit: 'kg', price: 18, idealTemp: 3, maxSafeTemp: 8, q10: 2.2, rh: [60, 95], baseShelfH: 504, highRisk: true },
  { id: 'halloumi', name: 'Halloumi cheese', category: 'dairy', icon: '🧀', unit: 'kg', price: 40, idealTemp: 4, maxSafeTemp: 10, q10: 2.0, rh: [60, 95], baseShelfH: 1080, highRisk: false },
  // Vegetables
  { id: 'lettuce', name: 'Iceberg lettuce', category: 'vegetables', icon: '🥬', unit: 'kg', price: 9, idealTemp: 1, maxSafeTemp: 12, q10: 2.8, rh: [90, 98], baseShelfH: 336, highRisk: false },
  { id: 'spinach', name: 'Baby spinach', category: 'vegetables', icon: '🌿', unit: 'kg', price: 22, idealTemp: 1, maxSafeTemp: 10, q10: 3.0, rh: [90, 98], baseShelfH: 192, highRisk: false },
  { id: 'tomato', name: 'Vine tomatoes', category: 'vegetables', icon: '🍅', unit: 'kg', price: 8, idealTemp: 12, maxSafeTemp: 25, q10: 2.2, rh: [85, 95], baseShelfH: 240, chillSensitive: true },
  { id: 'cucumber', name: 'Cucumbers', category: 'vegetables', icon: '🥒', unit: 'kg', price: 6, idealTemp: 11, maxSafeTemp: 25, q10: 2.1, rh: [85, 95], baseShelfH: 264, chillSensitive: true },
  // Fruits
  { id: 'strawberry', name: 'Strawberries', category: 'fruits', icon: '🍓', unit: 'kg', price: 38, idealTemp: 1, maxSafeTemp: 10, q10: 3.5, rh: [90, 95], baseShelfH: 168 },
  { id: 'grapes', name: 'Red grapes', category: 'fruits', icon: '🍇', unit: 'kg', price: 20, idealTemp: 0, maxSafeTemp: 10, q10: 2.8, rh: [85, 95], baseShelfH: 720 },
  { id: 'mango', name: 'Alphonso mangoes', category: 'fruits', icon: '🥭', unit: 'kg', price: 28, idealTemp: 13, maxSafeTemp: 25, q10: 2.4, rh: [85, 95], baseShelfH: 336, chillSensitive: true },
  { id: 'banana', name: 'Bananas', category: 'fruits', icon: '🍌', unit: 'kg', price: 7, idealTemp: 14, maxSafeTemp: 25, q10: 2.5, rh: [85, 95], baseShelfH: 240, chillSensitive: true },
];

// Each location has one IoT sensor pushing temperature / humidity / door state.
export const LOCATIONS = [
  { id: 'S-01', name: 'Chiller A — Meat & Seafood', site: 'Doha Central Cold Store', kind: 'room', setpoint: 1, rhSet: 88, categories: ['meat'] },
  { id: 'S-02', name: 'Chiller B — Dairy', site: 'Doha Central Cold Store', kind: 'room', setpoint: 3, rhSet: 80, categories: ['dairy'] },
  { id: 'S-03', name: 'Produce Room — Leafy & Berries', site: 'Doha Central Cold Store', kind: 'room', setpoint: 2, rhSet: 92, categories: ['lettuce', 'spinach', 'strawberry', 'grapes'] },
  { id: 'S-04', name: 'Tropical Room — Chill-sensitive', site: 'Doha Central Cold Store', kind: 'room', setpoint: 12, rhSet: 90, categories: ['tomato', 'cucumber', 'mango', 'banana'] },
  { id: 'S-05', name: 'Reefer truck QTR-12', site: 'Hamad Port → Doha', kind: 'truck', setpoint: 2, rhSet: 88, etaH: 3 },
  { id: 'S-06', name: 'Reefer truck QTR-07', site: 'Abu Samra border → Doha', kind: 'truck', setpoint: 3, rhSet: 88, etaH: 5 },
];

// What the platform does with each AI grade.
export const ROUTES = {
  good: { label: 'Good', channel: 'Regular customers (standing orders)', priceFactor: 1.0, description: 'Sent to restaurants and households that ordered at full price.' },
  mid: { label: 'Mid', channel: 'Small shops & middlemen', priceFactor: 0.8, description: 'Offered wholesale (20% off) to groceries, baqalas and resellers who sell it quickly.' },
  low: { label: 'Low', channel: 'Flash sale — instant consumers', priceFactor: 0.5, description: '50% off for customers who will consume it today. Matching customers get a push notification.' },
  dispose: { label: 'Dispose', channel: 'Disposal / compost', priceFactor: 0, description: 'Removed from sale immediately and logged for disposal.' },
};

export const GRADE_ORDER = ['good', 'mid', 'low', 'dispose'];

export const productById = Object.fromEntries(PRODUCTS.map(p => [p.id, p]));
export const locationById = Object.fromEntries(LOCATIONS.map(l => [l.id, l]));

// The cold room a product belongs in (used when a truck is rerouted / unloaded).
export function homeRoomFor(product) {
  return LOCATIONS.find(l => l.kind === 'room' && (l.categories.includes(product.id) || l.categories.includes(product.category)));
}
