/**
 * Writes sample documents to try Documents upload against the Sharma Building Supplies demo company:
 * a bank statement (CSV), a journal / workings sheet (Excel) and a sales register (CSV).
 * Dates are relative to today so they line up with the demo vouchers.
 *
 *   npm run samples --workspace server            (files go to ./samples)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { makeGstin } from '../lib/gstin';
import { addDays, todayIST } from '../lib/dates';

const out = resolve(process.argv[2] ?? resolve(import.meta.dirname, '../../../samples'));
const today = todayIST();
const d = (ago: number) => addDays(today, -ago);
const dmy = (iso: string) => iso.split('-').reverse().join('/');

async function main() {
  await mkdir(out, { recursive: true });

  // Bank statement. Four lines match demo vouchers already in the books; the rest are new.
  const rows: [number, string, number, number][] = [
    [15, 'NEFT CR-HDFC0001234-RAJESH TRADERS-PART PAYMENT', 0, 20000],
    [12, 'CHQ PAID-004512-SHREE BALAJI CEMENT AGENCY', 50000, 0],
    [8, 'UPI/412345678901/RAJESH TRADERS/rajesh@okhdfc/Payment', 0, 25000],
    [7, 'ATM WDL/CHENNAI ANNA NAGAR', 5000, 0],
    [6, 'SMS CHRG FOR QTR SEP', 17.7, 0],
    [5, 'RENT SEPT - SHOP', 25000, 0],
    [4, 'NEFT/MEHTA CONSTRUCTIONS/INV 4', 0, 37524],
    [3, 'UPI/9988776655/XYZ NETWORKS/xyz@ybl/Pay', 1234, 0],
    [2, 'CASH DEP-ANNA NAGAR BRANCH', 0, 30000],
    [1, 'SB INT PD UPTO 30-SEP', 0, 150],
  ];
  let bal = 100000;
  const lines = rows.map(([ago, narr, wd, dep]) => {
    bal = Math.round((bal - wd + dep) * 100) / 100;
    return `${dmy(d(ago))},"${narr}",REF${ago},${dmy(d(ago))},${wd || ''},${dep || ''},${bal.toFixed(2)}`;
  });
  await writeFile(resolve(out, 'hdfc-statement.csv'),
    ['HDFC BANK LTD', 'Account No : XXXXXXXX4321', '', 'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance', ...lines, ''].join('\n'));

  // Workings: month-end journal adjustments.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Adjustments');
  ws.addRow(['Month-end adjustments']);
  ws.addRow(['JV No', 'Date', 'Ledger', 'Debit', 'Credit', 'Narration']);
  ws.addRow(['JV1', dmy(d(1)), 'Depreciation', 12000, null, 'Depreciation on furniture']);
  ws.addRow(['JV1', null, 'Furniture & Fixtures', null, 12000, null]);
  ws.addRow(['JV2', dmy(d(1)), 'Electricity', 4500, null, 'Provision for electricity']);
  ws.addRow(['JV2', null, 'Outstanding Expenses', null, 4500, null]);
  await writeFile(resolve(out, 'month-end-workings.xlsx'), Buffer.from(await wb.xlsx.writeBuffer()));

  // Sales register: one known customer, one new (Tamil Nadu, so IGST).
  await writeFile(resolve(out, 'sales-register.csv'), [
    'Sales Register',
    'Invoice No,Invoice Date,Customer Name,GSTIN,Taxable Value,CGST,SGST,IGST,Invoice Value',
    `INV-101,${dmy(d(2))},Rajesh Traders,${makeGstin('27', 'AAJFR1234M')},10000,900,900,,11800`,
    `INV-102,${dmy(d(1))},Kumar Stores,${makeGstin('33', 'AAKFK1111Q')},5000,,,900,5900`,
    'Total,,,,15000,900,900,900,17700',
    '',
  ].join('\n'));

  console.log(`Sample documents written to ${out}`);
}

void main();
