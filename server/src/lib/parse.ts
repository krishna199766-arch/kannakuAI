import Decimal from 'decimal.js';

/** A spreadsheet cell after reading: text, number, date or empty. */
export type Cell = string | number | Date | null;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;          // 31-Feb etc.
  return dt.toISOString().slice(0, 10);
}

/**
 * Indian statements are day-first: 03/04/2026 is 3 April. Accepts Date cells, Excel serial numbers,
 * 2026-04-03, 03/04/2026, 03-04-26, 03.04.2026, 03-Apr-2026, 3 April 2026, Apr 3, 2026.
 */
export function parseDate(c: Cell): string | null {
  if (c === null || c === undefined || c === '') return null;
  if (c instanceof Date) return Number.isNaN(c.getTime()) ? null : c.toISOString().slice(0, 10);
  if (typeof c === 'number') {
    if (c > 20000 && c < 80000) {                       // Excel serial date
      const ms = Math.round((c - 25569) * 864e5);
      return new Date(ms).toISOString().slice(0, 10);
    }
    return null;
  }
  const s = c.trim().replace(/\s+/g, ' ');
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/., ]+(\d{2,4})\b/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = s.match(/^([A-Za-z]{3,9}) (\d{1,2}),? (\d{4})\b/);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  return null;
}

/**
 * "1,23,456.50" | "₹ 500" | "(250.00)" | "500.00 Dr" | "-75" | 1234.5 -> signed Decimal.
 * A trailing Dr makes it negative, Cr positive. Blank or "-" -> null.
 */
export function parseAmount(c: Cell): Decimal | null {
  if (c === null || c === undefined || c instanceof Date) return null;
  if (typeof c === 'number') return Number.isFinite(c) ? new Decimal(c) : null;
  let s = c.trim();
  if (!s || /^[-–—]+$/.test(s)) return null;
  let sign = 1;
  const drcr = s.match(/\b(dr|cr)\.?$/i);
  if (drcr) { if (drcr[1].toLowerCase() === 'dr') sign = -1; s = s.slice(0, drcr.index).trim(); }
  if (/^\(.*\)$/.test(s)) { sign *= -1; s = s.slice(1, -1); }
  s = s.replace(/₹|rs\.?|inr/gi, '').replace(/[,\s]/g, '');
  if (s.startsWith('-')) { sign *= -1; s = s.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const d = new Decimal(s);
  return sign < 0 ? d.neg() : d;
}

/** Decimal rupees -> paise (half-up). */
export const decToMinor = (d: Decimal) => BigInt(d.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));

export const cellText = (c: Cell): string =>
  c === null || c === undefined ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c).trim();

/** Lower-case header text with punctuation collapsed, for column matching. */
export const headerKey = (c: Cell) => cellText(c).toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
