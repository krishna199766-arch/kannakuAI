const CS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function checkChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CS[(36 - (sum % 36)) % 36];
}

/** Format + mod-36 check digit. */
export function isValidGstin(g: string | null | undefined): boolean {
  if (!g) return false;
  const s = g.trim().toUpperCase();
  return GSTIN_RE.test(s) && checkChar(s.slice(0, 14)) === s[14];
}

/** Builds a valid GSTIN from state code + PAN (+ entity number). Used for seed data and tests. */
export function makeGstin(stateCode: string, pan: string, entity = '1'): string {
  const first14 = `${stateCode}${pan}${entity}Z`;
  return first14 + checkChar(first14);
}

export const gstinState = (g: string) => g.slice(0, 2);
export const gstinPan = (g: string) => g.slice(2, 12);

export const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '97': 'Other Territory',
};

/** "Maharashtra" | "27" | "MAHARASHTRA (27)" -> "27" */
export function stateCodeFrom(text: string | null | undefined): string | null {
  if (!text) return null;
  const digits = text.match(/\b(\d{2})\b/);
  if (digits && STATES[digits[1]]) return digits[1];
  const t = text.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [code, name] of Object.entries(STATES)) {
    if (t.includes(name.toLowerCase())) return code;
  }
  return null;
}
