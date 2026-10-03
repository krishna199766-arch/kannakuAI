import { many, one, type Db } from '../db/client';
import { addDays, fyStart } from '../lib/dates';
import { stockValueMinor } from '../inventory/stock';

type Nature = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

interface GroupRow { id: string; parent_id: string | null; name: string; nature: Nature; affects_gross_profit: boolean; system_code: string | null; sort_order: number }
interface LedgerAmountRow { id: string; name: string; group_id: string; amount: bigint }

export interface TreeNode {
  kind: 'group' | 'ledger' | 'virtual';
  id: string;
  name: string;
  amountMinor: bigint;             // natural sign: + = the side this report shows it on
  children: TreeNode[];
}

async function companyFy(db: Db, companyId: string) {
  return one<{ fy_start_month: number; books_from: string; name: string }>(db,
    `SELECT fy_start_month, books_from::text, name FROM companies WHERE id = $1`, [companyId]);
}

async function groups(db: Db, companyId: string) {
  return many<GroupRow>(db,
    `SELECT id, parent_id, name, nature, affects_gross_profit, system_code, sort_order
       FROM ledger_groups WHERE company_id = $1 ORDER BY sort_order, name`, [companyId]);
}

/** Sum of entries per ledger within [from, to]; from = null means from the beginning. */
async function ledgerAmounts(db: Db, companyId: string, from: string | null, to: string, natures: Nature[]) {
  return many<LedgerAmountRow>(db,
    `SELECT l.id, l.name, l.group_id, COALESCE(SUM(e.amount_minor), 0)::bigint AS amount
       FROM ledgers l
       JOIN ledger_groups g ON g.id = l.group_id
       LEFT JOIN ledger_entries e ON e.ledger_id = l.id AND e.voucher_date <= $2 AND ($3::date IS NULL OR e.voucher_date >= $3)
      WHERE l.company_id = $1 AND g.nature::text = ANY($4::text[])
      GROUP BY l.id, l.name, l.group_id
      ORDER BY l.name`, [companyId, to, from, natures]);
}

/** Builds group trees; `sign` turns raw debit-positive sums into the report's natural sign. */
function buildTrees(gs: GroupRow[], ledgers: LedgerAmountRow[], rootFilter: (g: GroupRow) => boolean, sign: (g: GroupRow) => bigint): TreeNode[] {
  const byParent = new Map<string | null, GroupRow[]>();
  for (const g of gs) byParent.set(g.parent_id, [...(byParent.get(g.parent_id) ?? []), g]);
  const ledgersByGroup = new Map<string, LedgerAmountRow[]>();
  for (const l of ledgers) ledgersByGroup.set(l.group_id, [...(ledgersByGroup.get(l.group_id) ?? []), l]);
  const gById = new Map(gs.map((g) => [g.id, g]));

  const build = (g: GroupRow): TreeNode => {
    const children: TreeNode[] = [
      ...(byParent.get(g.id) ?? []).map(build),
      ...(ledgersByGroup.get(g.id) ?? []).map((l) => ({
        kind: 'ledger' as const, id: l.id, name: l.name, amountMinor: l.amount * sign(gById.get(l.group_id)!), children: [],
      })),
    ].filter((c) => c.amountMinor !== 0n || c.children.length > 0);
    return { kind: 'group', id: g.id, name: g.name, amountMinor: children.reduce((s, c) => s + c.amountMinor, 0n), children };
  };
  return (byParent.get(null) ?? []).filter(rootFilter).map(build);
}

export async function trialBalance(db: Db, companyId: string, asOf: string) {
  const c = await companyFy(db, companyId);
  const fs = fyStart(asOf, c.fy_start_month);
  const rows = await many<{ id: string; name: string; group_id: string; nature: Nature; closing: bigint; prior: bigint }>(db,
    `SELECT l.id, l.name, l.group_id, g.nature,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE g.nature IN ('ASSET','LIABILITY','EQUITY') OR e.voucher_date >= $3), 0)::bigint AS closing,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE g.nature IN ('INCOME','EXPENSE') AND e.voucher_date < $3), 0)::bigint AS prior
       FROM ledgers l
       JOIN ledger_groups g ON g.id = l.group_id
       LEFT JOIN ledger_entries e ON e.ledger_id = l.id AND e.voucher_date <= $2
      WHERE l.company_id = $1
      GROUP BY l.id, l.name, l.group_id, g.nature`, [companyId, asOf, fs]);
  const gs = await groups(db, companyId);
  const priorPl = rows.reduce((s, r) => s + r.prior, 0n);
  const trees = buildTrees(gs, rows.map((r) => ({ id: r.id, name: r.name, group_id: r.group_id, amount: r.closing })), () => true, () => 1n);
  if (priorPl !== 0n) {
    trees.push({ kind: 'virtual', id: 'prior-pl', name: 'Profit & Loss A/c (earlier years)', amountMinor: priorPl, children: [] });
  }
  const totalDebit = rows.reduce((s, r) => (r.closing > 0n ? s + r.closing : s), 0n) + (priorPl > 0n ? priorPl : 0n);
  const totalCredit = rows.reduce((s, r) => (r.closing < 0n ? s - r.closing : s), 0n) + (priorPl < 0n ? -priorPl : 0n);
  return { asOf, fyStart: fs, groups: trees, totalDebitMinor: totalDebit, totalCreditMinor: totalCredit };
}

export async function profitAndLoss(db: Db, companyId: string, from: string, to: string) {
  const gs = await groups(db, companyId);
  const ledgers = await ledgerAmounts(db, companyId, from, to, ['INCOME', 'EXPENSE']);
  const openingStock = await stockValueMinor(db, companyId, addDays(from, -1));
  const closingStock = await stockValueMinor(db, companyId, to);
  // Incomes show as positive credits, expenses as positive debits.
  const sign = (g: GroupRow) => (g.nature === 'INCOME' ? -1n : 1n);
  const trading = (g: GroupRow) => g.affects_gross_profit;
  const tradingDebit = buildTrees(gs, ledgers, (g) => trading(g) && g.nature === 'EXPENSE', sign);
  const tradingCredit = buildTrees(gs, ledgers, (g) => trading(g) && g.nature === 'INCOME', sign);
  const indirectExpenses = buildTrees(gs, ledgers, (g) => !trading(g) && g.nature === 'EXPENSE', sign);
  const indirectIncomes = buildTrees(gs, ledgers, (g) => !trading(g) && g.nature === 'INCOME', sign);
  const sum = (ns: TreeNode[]) => ns.reduce((s, n) => s + n.amountMinor, 0n);

  const grossProfit = sum(tradingCredit) + closingStock - (openingStock + sum(tradingDebit));
  const netProfit = grossProfit + sum(indirectIncomes) - sum(indirectExpenses);
  return {
    from, to,
    openingStockMinor: openingStock,
    closingStockMinor: closingStock,
    tradingDebit, tradingCredit, indirectExpenses, indirectIncomes,
    grossProfitMinor: grossProfit,
    netProfitMinor: netProfit,
  };
}

export async function balanceSheet(db: Db, companyId: string, asOf: string) {
  const c = await companyFy(db, companyId);
  const fs = fyStart(asOf, c.fy_start_month);
  const gs = await groups(db, companyId);
  const ledgers = await ledgerAmounts(db, companyId, null, asOf, ['ASSET', 'LIABILITY', 'EQUITY']);
  const prior = await one<{ s: bigint }>(db,
    `SELECT COALESCE(SUM(e.amount_minor), 0)::bigint AS s FROM ledger_entries e
       JOIN ledgers l ON l.id = e.ledger_id JOIN ledger_groups g ON g.id = l.group_id
      WHERE e.company_id = $1 AND g.nature IN ('INCOME','EXPENSE') AND e.voucher_date < $2`, [companyId, fs]);
  const stockAtFyStart = await stockValueMinor(db, companyId, addDays(fs, -1));
  const priorProfit = -prior.s + stockAtFyStart;
  const pl = await profitAndLoss(db, companyId, fs, asOf);

  const liabilities = buildTrees(gs, ledgers, (g) => g.nature !== 'ASSET', () => -1n);
  const assets = buildTrees(gs, ledgers, (g) => g.nature === 'ASSET', () => 1n);

  // Closing stock sits under Current Assets > Stock-in-Hand.
  if (pl.closingStockMinor !== 0n) {
    const ca = assets.find((n) => gs.find((g) => g.id === n.id)?.system_code === 'CURRENT_ASSETS');
    const stockGroup = gs.find((g) => g.system_code === 'STOCK_IN_HAND');
    if (ca && stockGroup) {
      let node = ca.children.find((n) => n.id === stockGroup.id);
      if (!node) { node = { kind: 'group', id: stockGroup.id, name: stockGroup.name, amountMinor: 0n, children: [] }; ca.children.push(node); }
      node.children.push({ kind: 'virtual', id: 'closing-stock', name: 'Closing Stock', amountMinor: pl.closingStockMinor, children: [] });
      node.amountMinor += pl.closingStockMinor;
      ca.amountMinor += pl.closingStockMinor;
    }
  }
  liabilities.push({
    kind: 'virtual', id: 'pl-account', name: 'Profit & Loss A/c', amountMinor: priorProfit + pl.netProfitMinor,
    children: [
      { kind: 'virtual' as const, id: 'pl-opening', name: 'Opening balance', amountMinor: priorProfit, children: [] },
      { kind: 'virtual' as const, id: 'pl-current', name: 'Current period', amountMinor: pl.netProfitMinor, children: [] },
    ].filter((n) => n.amountMinor !== 0n),
  });
  const totalAssets = assets.reduce((s, n) => s + n.amountMinor, 0n);
  const totalLiabilities = liabilities.reduce((s, n) => s + n.amountMinor, 0n);
  return {
    asOf, fyStart: fs,
    liabilities: liabilities.filter((n) => n.amountMinor !== 0n || n.children.length),
    assets: assets.filter((n) => n.amountMinor !== 0n || n.children.length),
    totalAssetsMinor: totalAssets,
    totalLiabilitiesMinor: totalLiabilities,
    differenceMinor: totalAssets - totalLiabilities,
  };
}
