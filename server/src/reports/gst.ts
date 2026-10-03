import { many, type Db } from '../db/client';

/** Output vs input tax for a period, by component and rate — the numbers behind GSTR-3B. */
export async function gstSummary(db: Db, companyId: string, from: string, to: string) {
  const rows = await many<{ direction: 'INPUT' | 'OUTPUT'; component: string; rate_ppm: number; reverse_charge: boolean; itc_eligible: boolean; taxable: bigint; tax: bigint }>(db,
    `SELECT direction, component, rate_ppm, reverse_charge, itc_eligible,
            SUM(taxable_minor)::bigint AS taxable, SUM(tax_minor)::bigint AS tax
       FROM voucher_tax_lines
      WHERE company_id = $1 AND voucher_date BETWEEN $2 AND $3
      GROUP BY direction, component, rate_ppm, reverse_charge, itc_eligible
      ORDER BY direction DESC, component, rate_ppm`, [companyId, from, to]);
  const components = ['IGST', 'CGST', 'SGST', 'UTGST', 'CESS'];
  const byComponent = components.map((c) => {
    const out = rows.filter((r) => r.component === c && r.direction === 'OUTPUT').reduce((s, r) => s + r.tax, 0n);
    const rcm = rows.filter((r) => r.component === c && r.direction === 'INPUT' && r.reverse_charge).reduce((s, r) => s + r.tax, 0n);
    const itc = rows.filter((r) => r.component === c && r.direction === 'INPUT' && r.itc_eligible).reduce((s, r) => s + r.tax, 0n);
    return { component: c, outputMinor: out, rcmMinor: rcm, itcMinor: itc, netPayableMinor: out + rcm - itc };
  }).filter((r) => r.outputMinor || r.rcmMinor || r.itcMinor);

  const sales = await many(db,
    `SELECT CASE WHEN cp.gstin IS NULL THEN 'B2C' ELSE 'B2B' END AS kind,
            CASE WHEN tl.component = 'IGST' THEN 'INTER' ELSE 'INTRA' END AS supply,
            CASE WHEN tl.component = 'IGST' THEN tl.rate_ppm ELSE tl.rate_ppm * 2 END AS "ratePpm",
            COALESCE(SUM(tl.taxable_minor) FILTER (WHERE tl.component IN ('IGST','CGST')), 0)::bigint AS "taxableMinor",
            SUM(tl.tax_minor)::bigint AS "taxMinor"
       FROM voucher_tax_lines tl JOIN vouchers v ON v.id = tl.voucher_id
       LEFT JOIN counterparties cp ON cp.id = v.counterparty_id
      WHERE tl.company_id = $1 AND tl.voucher_date BETWEEN $2 AND $3 AND tl.direction = 'OUTPUT' AND tl.component <> 'CESS'
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3`, [companyId, from, to]);
  return {
    from, to,
    lines: rows.map((r) => ({
      direction: r.direction, component: r.component, ratePpm: r.rate_ppm, reverseCharge: r.reverse_charge,
      itcEligible: r.itc_eligible, taxableMinor: r.taxable, taxMinor: r.tax,
    })),
    byComponent,
    netPayableMinor: byComponent.reduce((s, r) => s + r.netPayableMinor, 0n),
    salesByRate: sales,
  };
}
