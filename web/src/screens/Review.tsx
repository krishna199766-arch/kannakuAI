import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, c, ApiError, type Posted, type Preview, type VoucherInput, type ItemLineInput } from '../api';
import { useApp } from '../state';
import { useKeys } from '../keys';
import { Picker, type Option } from '../components/Picker';
import { Empty, ErrorBox, Kbd, ScreenHead } from '../components/ui';
import { fmtDate, inr, pct, toMinor } from '../format';

interface DocRow { id: string; fileName: string; mime: string; status: string; error: string | null; createdAt: string; voucherId: string | null; supplier: string | null; invoiceNo: string | null; grandTotal: string | null; errors: number }

const STATUS: Record<string, string> = { RECEIVED: 'queued', PROCESSING: 'reading…', NEEDS_REVIEW: 'needs review', ACCEPTED: 'posted', REJECTED: 'rejected', FAILED: 'failed' };

export function ReviewQueue({ params }: { params?: { upload?: boolean } }) {
  const app = useApp();
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api.get<DocRow[]>(c('/documents')).then(setDocs), []);
  useEffect(() => { void load(); }, [load, app.dataVersion]);
  useEffect(() => {
    if (!docs.some((d) => d.status === 'RECEIVED' || d.status === 'PROCESSING')) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [docs, load]);
  useEffect(() => { if (params?.upload) setTimeout(() => fileRef.current?.click(), 50); }, [params?.upload]);
  useKeys({ 'Ctrl+U': () => { fileRef.current?.click(); } });

  const upload = async (files: FileList | File[]) => {
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append('file', f, f.name);
    try {
      const r = await api.post<{ fileName: string; error?: { message: string } }[]>(c('/documents'), fd);
      setUploadErrors(r.filter((x) => x.error).map((x) => `${x.fileName}: ${x.error!.message}`));
      const ok = r.filter((x) => !x.error).length;
      if (ok) app.toast(`${ok} file${ok > 1 ? 's' : ''} queued for reading`);
      void load();
    } catch (e) { setUploadErrors([e instanceof ApiError ? e.message : String(e)]); }
  };

  return (
    <div>
      <ScreenHead title="Scanned bills" sub="Upload purchase bills and receipts. AI reads them into draft vouchers; you check and post.">
        <button className="primary" onClick={() => fileRef.current?.click()}>Upload <Kbd>Ctrl+U</Kbd></button>
      </ScreenHead>
      {!app.status.aiEnabled && <div className="warn">Bill reading needs ANTHROPIC_API_KEY in the project's .env file. Uploads will queue and fail until it is set.</div>}
      <input ref={fileRef} type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" hidden onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ''; }} />
      <div className={`dropzone ${dragging ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}
        onClick={() => fileRef.current?.click()} role="button" tabIndex={0}>
        Drop PDFs or photos of bills here, or click to choose files
      </div>
      {uploadErrors.map((e) => <div key={e} className="error-box">{e}</div>)}
      {docs.length === 0 ? <Empty>No bills yet.</Empty> : (
        <table className="list selectable">
          <thead><tr><th>Uploaded</th><th>File</th><th>Supplier</th><th>Invoice</th><th className="num">Total ₹</th><th>Status</th></tr></thead>
          <tbody>{docs.map((d) => (
            <tr key={d.id} tabIndex={0} className="clickable" onClick={() => app.go({ screen: 'review-doc', params: { id: d.id } })}
              onKeyDown={(e) => { if (e.key === 'Enter') app.go({ screen: 'review-doc', params: { id: d.id } }); }}>
              <td>{new Date(d.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              <td>{d.fileName}</td><td>{d.supplier ?? '—'}</td><td>{d.invoiceNo ?? '—'}</td>
              <td className="num">{d.grandTotal ? inr(toMinor(d.grandTotal) ?? 0n) : ''}</td>
              <td><span className={`status st-${d.status.toLowerCase()}`}>{STATUS[d.status]}</span>{d.errors > 0 && d.status === 'NEEDS_REVIEW' && <small className="bad"> · {d.errors} to fix</small>}{d.error && <small className="bad"> · {d.error.slice(0, 60)}</small>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

interface Issue { code: string; field: string; severity: 'error' | 'warning' | 'info'; message: string }
interface PartyCand { id: string; name: string; gstin: string | null; city: string | null; score: number }
interface Detail {
  id: string; fileName: string; mime: string; status: string; error: string | null; voucherId: string | null; model: string | null;
  extraction: { supplier: { name: { value: string | null }; gstin: { value: string | null } }; invoice_number: { value: string | null; raw: string | null }; totals: { grand_total: { value: string | null } }; document_type: string } | null;
  validation: Issue[] | null;
  matches: { party: { status: string; reason: string; match: PartyCand | null; candidates: PartyCand[] }; proposedParty: { name: string; gstin: string | null; stateCode: string | null; creditDays: number | null } | null; lines: { description: string; itemName: string | null; ledgerName: string | null; reason: string; score: number }[]; recomputedTotal: string | null } | null;
  draft: VoucherInput | null;
}

export function ReviewDoc({ params }: { params: { id: string } }) {
  const app = useApp();
  const [d, setD] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<VoucherInput | null>(null);
  const [newParty, setNewParty] = useState<{ name: string; gstin: string; stateCode: string; creditDays: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<{ message: string; details?: unknown } | null>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    const doc = await api.get<Detail>(c(`/documents/${params.id}`));
    setD(doc);
    if (doc.draft) setDraft(doc.draft);
    if (doc.matches?.proposedParty && !doc.draft?.counterpartyId) {
      const p = doc.matches.proposedParty;
      setNewParty({ name: p.name, gstin: p.gstin ?? '', stateCode: p.stateCode ?? '', creditDays: p.creditDays ? String(p.creditDays) : '' });
    }
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (d && (d.status === 'RECEIVED' || d.status === 'PROCESSING')) { const t = setTimeout(() => void load(), 2000); return () => clearTimeout(t); }
  }, [d, load]);

  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(async () => {
      try {
        const p = await api.post<Preview>(c('/vouchers/preview'), { ...draft, paymentMode: draft.counterpartyId ? draft.paymentMode : 'CASH', confirmWarnings: true });
        setPreview(p);
      } catch { setPreview(null); }
    }, 250);
    return () => clearTimeout(t);
  }, [draft]);

  const lineOptions: Option[] = useMemo(() => [
    ...app.masters.items.map((i) => ({ id: `item:${i.id}`, label: i.name, sub: `${i.uom} · ${pct(i.gstRatePpm)}` })),
    ...app.masters.ledgers.filter((l) => ['EXPENSE'].includes(l.nature) || l.path.includes('fixed_assets')).filter((l) => !l.taxComponent && l.systemCode !== 'ROUND_OFF')
      .map((l) => ({ id: `ledger:${l.id}`, label: l.name, sub: l.groupName })),
  ], [app.masters]);
  const partyOptions: Option[] = useMemo(() => app.masters.parties.map((p) => ({ id: p.id, label: p.name, sub: [p.city, p.gstin].filter(Boolean).join(' · ') })), [app.masters.parties]);

  const setLine = (i: number, patch: Partial<ItemLineInput>) => setDraft((dr) => dr && ({ ...dr, items: dr.items!.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  const accept = async () => {
    if (!draft || !d) return;
    try {
      const posted = await api.post<Posted>(c(`/documents/${d.id}/accept`), {
        draft,
        newParty: !draft.counterpartyId && newParty ? { ...newParty, gstin: newParty.gstin || null, stateCode: newParty.stateCode || null, creditDays: newParty.creditDays ? Number(newParty.creditDays) : null } : null,
        confirmWarnings: confirm !== null,
      });
      app.toast(`Posted Purchase No. ${posted.voucherNo} · ₹${inr(posted.totalMinor)}`);
      app.bumpData();
      app.back();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRM_WARNINGS') setConfirm((e.details as { warnings: { message: string }[] }).warnings.map((w) => w.message));
      else setErr(e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) });
    }
  };
  const reject = async () => {
    if (!d || !window.confirm('Reject this bill? Nothing will be posted.')) return;
    await api.post(c(`/documents/${d.id}/reject`), {});
    app.bumpData();
    app.back();
  };
  useKeys({ 'Ctrl+A': () => { void accept(); }, 'Alt+R': () => { void reject(); } });

  if (!d) return <div className="muted">Loading…</div>;
  const fileUrl = c(`/documents/${d.id}/file`);
  const printed = d.extraction?.totals.grand_total.value;
  const ours = preview ? BigInt(preview.totalMinor) : null;
  const printedMinor = printed ? toMinor(printed) : null;
  const totalsMatch = ours !== null && printedMinor !== null && (ours - printedMinor <= 100n && printedMinor - ours <= 100n);
  const issues = d.validation ?? [];
  const editable = d.status === 'NEEDS_REVIEW' || d.status === 'FAILED';

  return (
    <div className="review">
      <ScreenHead title={d.extraction?.supplier.name.value ?? d.fileName} sub={`${d.fileName} · ${STATUS[d.status]}${d.model ? ` · read by ${d.model}` : ''}`}>
        {d.status === 'FAILED' && <button onClick={() => void api.post(c(`/documents/${d.id}/retry`), {}).then(load)}>Retry</button>}
        {editable && draft && <button className="danger" onClick={() => void reject()}>Reject <Kbd>Alt+R</Kbd></button>}
        {editable && draft && <button className="primary" onClick={() => void accept()}>Post purchase <Kbd>Ctrl+A</Kbd></button>}
        {d.voucherId && <button onClick={() => app.go({ screen: 'voucher-view', params: { id: d.voucherId } })}>Open voucher</button>}
      </ScreenHead>
      {d.error && <div className="error-box">{d.error}</div>}
      <div className="review-split">
        <div className="doc-pane">
          {d.mime === 'application/pdf' ? <iframe src={fileUrl} title="Bill" /> : <img src={fileUrl} alt="Scanned bill" />}
        </div>
        <div className="form-pane">
          {(d.status === 'RECEIVED' || d.status === 'PROCESSING') && <p className="muted">Reading the bill…</p>}
          {issues.length > 0 && (
            <ul className="issues">
              {issues.map((i, k) => <li key={k} className={i.severity}><strong>{i.severity === 'error' ? 'Fix' : i.severity === 'warning' ? 'Check' : 'OK'}</strong> {i.message}</li>)}
            </ul>
          )}
          {draft && d.matches && (
            <>
              <h3>Supplier</h3>
              <div className="match">
                <span className={`pill ${d.matches.party.status.toLowerCase()}`}>{d.matches.party.status === 'MATCHED' ? 'matched' : d.matches.party.status === 'SUGGEST' ? 'please choose' : 'new supplier'}</span>
                <small className="muted"> {d.matches.party.reason}</small>
              </div>
              <Picker options={partyOptions} value={draft.counterpartyId ?? null} onChange={(id) => setDraft({ ...draft, counterpartyId: id })} placeholder="Choose existing supplier…" />
              {d.matches.party.candidates.length > 0 && !draft.counterpartyId && (
                <div className="cands">Similar: {d.matches.party.candidates.map((p) => <button key={p.id} className="link" onClick={() => setDraft({ ...draft, counterpartyId: p.id })}>{p.name} ({Math.round(p.score * 100)}%)</button>)}</div>
              )}
              {!draft.counterpartyId && newParty && (
                <fieldset className="new-party">
                  <legend>…or create this supplier on posting</legend>
                  <label>Name<input value={newParty.name} onChange={(e) => setNewParty({ ...newParty, name: e.target.value })} /></label>
                  <label>GSTIN<input value={newParty.gstin} onChange={(e) => setNewParty({ ...newParty, gstin: e.target.value.toUpperCase() })} /></label>
                  <label>State<select value={newParty.stateCode} onChange={(e) => setNewParty({ ...newParty, stateCode: e.target.value })}><option value="">—</option>{Object.entries(app.status.states).map(([k, v]) => <option key={k} value={k}>{k} {v}</option>)}</select></label>
                  <label>Credit days<input value={newParty.creditDays} onChange={(e) => setNewParty({ ...newParty, creditDays: e.target.value })} /></label>
                </fieldset>
              )}

              <h3>Invoice</h3>
              <div className="field-row">
                <label>Invoice no.<input value={draft.partyRefNo ?? ''} onChange={(e) => setDraft({ ...draft, partyRefNo: e.target.value })} maxLength={16} /></label>
                <label className="w-date">Invoice date<input type="date" value={draft.partyRefDate ?? ''} onChange={(e) => setDraft({ ...draft, partyRefDate: e.target.value, date: e.target.value })} /></label>
                <label>Mode<select value={draft.paymentMode} onChange={(e) => setDraft({ ...draft, paymentMode: e.target.value as 'CREDIT' })}><option value="CREDIT">Credit</option><option value="CASH">Cash</option><option value="BANK">Bank</option></select></label>
                <label className="check"><input type="checkbox" checked={Boolean(draft.reverseCharge)} onChange={(e) => setDraft({ ...draft, reverseCharge: e.target.checked })} /> Reverse charge</label>
              </div>

              <h3>Lines</h3>
              <table className="grid">
                <thead><tr><th>As printed</th><th>Post to</th><th className="num">Qty</th><th className="num">Amount ₹</th><th className="num">GST %</th></tr></thead>
                <tbody>{draft.items!.map((l, i) => {
                  const m = d.matches!.lines[i];
                  const ref = l.itemId ? `item:${l.itemId}` : l.ledgerId ? `ledger:${l.ledgerId}` : null;
                  return (
                    <tr key={i}>
                      <td className="printed">{l.description}{m && <small className="muted"> · {m.reason}</small>}</td>
                      <td className="w-item"><Picker options={lineOptions} value={ref} placeholder="Default: Purchase ledger"
                        onChange={(id) => setLine(i, id?.startsWith('item:') ? { itemId: id.slice(5), ledgerId: null } : { itemId: null, ledgerId: id ? id.slice(7) : null, qty: null })} /></td>
                      <td className="w-num"><input className="num" value={l.qty ?? ''} onChange={(e) => setLine(i, { qty: e.target.value || null })} disabled={!l.itemId} /></td>
                      <td className="w-amt"><input className="num" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} /></td>
                      <td className="w-rate"><input className="num" value={l.gstRate} onChange={(e) => setLine(i, { gstRate: e.target.value })} /></td>
                    </tr>
                  );
                })}</tbody>
              </table>
              {preview && (
                <dl className="totals">
                  <dt>Taxable</dt><dd className="num">{inr(preview.taxableMinor)}</dd>
                  <dt>GST</dt><dd className="num">{inr(preview.taxMinor)}</dd>
                  <dt className="grand">Our total</dt><dd className="num grand">₹{inr(preview.totalMinor)}</dd>
                  <dt>Printed total</dt><dd className={`num ${totalsMatch ? 'ok' : 'bad'}`}>{printedMinor !== null ? `₹${inr(printedMinor)}` : 'not read'} {totalsMatch ? '✓ matches' : printedMinor !== null ? '✗ differs' : ''}</dd>
                </dl>
              )}
              {confirm && <div className="warn strong">{confirm.map((w) => <div key={w}>{w}</div>)}<div>Press <Kbd>Ctrl+A</Kbd> again to post anyway.</div></div>}
              <ErrorBox error={err} />
              <p className="muted small">Bill dated {fmtDate(draft.partyRefDate)} · voucher dated {fmtDate(draft.date)}. Corrections you make here teach the matcher for next time.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
