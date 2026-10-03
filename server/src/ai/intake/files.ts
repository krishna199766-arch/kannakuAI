import path from 'node:path';
import ExcelJS from 'exceljs';
import { AppError } from '../../lib/errors';
import { cellText, type Cell } from '../../lib/parse';

export type FileKind = 'pdf' | 'image' | 'sheet' | 'csv';
export interface Sheet { name: string; rows: Cell[][] }

const IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_ROWS = 5000;
const MAX_COLS = 40;

/** Decides how a file will be read; the browser's MIME type is not trusted alone. */
export function classifyFile(name: string, mime: string): { kind: FileKind; mime: string } {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.csv' || mime === 'text/csv') return { kind: 'csv', mime: 'text/csv' };
  if (ext === '.xlsx' || mime === XLSX_MIME) return { kind: 'sheet', mime: XLSX_MIME };
  if (ext === '.xls' || mime === 'application/vnd.ms-excel') {
    throw new AppError('OLD_EXCEL', 415, 'Old .xls files are not supported. In Excel use File > Save As > .xlsx (or .csv) and upload that.');
  }
  if (ext === '.pdf' || mime === 'application/pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (IMAGE.has(mime)) return { kind: 'image', mime };
  const byExt: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
  if (byExt[ext]) return { kind: 'image', mime: byExt[ext] };
  throw new AppError('UNSUPPORTED_FILE', 415, 'Upload a PDF, photo (JPEG, PNG, WebP), Excel (.xlsx) or CSV file');
}

/** Minimal RFC 4180 CSV reader; detects comma, semicolon or tab separators. */
export function parseCsv(text: string): Cell[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].map((s) => [s, firstLine.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field.trim() || null); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field.trim() || null); rows.push(row); row = []; field = '';
      if (rows.length >= MAX_ROWS) break;
    } else field += ch;
  }
  if (field || row.length) { row.push(field.trim() || null); rows.push(row); }
  return rows.map((r) => r.slice(0, MAX_COLS));
}

// exceljs cell values come in several shapes: rich text, formulas, hyperlinks, errors.
function excelValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const o = v as unknown as Record<string, unknown>;
  if ('result' in o) return excelValue(o.result as ExcelJS.CellValue);
  if ('richText' in o) return (o.richText as { text: string }[]).map((t) => t.text).join('');
  if ('text' in o) return String(o.text);
  if ('error' in o) return null;
  return null;
}

export async function readSheets(data: Buffer, kind: 'sheet' | 'csv'): Promise<Sheet[]> {
  if (kind === 'csv') return [{ name: 'CSV', rows: parseCsv(data.toString('utf8')) }];
  const wb = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(data as any);
  return wb.worksheets.filter((ws) => ws.state !== 'hidden').map((ws) => {
    const rows: Cell[][] = [];
    const last = Math.min(ws.rowCount, MAX_ROWS);
    const cols = Math.min(ws.columnCount, MAX_COLS);
    for (let r = 1; r <= last; r++) {
      const row = ws.getRow(r);
      const cells: Cell[] = [];
      for (let col = 1; col <= cols; col++) cells.push(excelValue(row.getCell(col).value));
      rows.push(cells);
    }
    return { name: ws.name, rows };
  });
}

/** A sheet as compact CSV-like text for the model (blank rows dropped, size capped). */
export function sheetToText(sheet: Sheet, maxRows = 400): string {
  const lines = sheet.rows
    .filter((r) => r.some((c) => cellText(c) !== ''))
    .slice(0, maxRows)
    .map((r) => r.map((c) => {
      const t = cellText(c);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    }).join(',').replace(/,+$/, ''));
  return `### Sheet: ${sheet.name}\n${lines.join('\n')}`;
}
