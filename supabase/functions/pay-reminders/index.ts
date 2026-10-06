// NOVA Compass — lembretes de pagamento automáticos
// Corre uma vez por dia (pg_cron, ver lembretes_pagamento.sql). Pronto pagamento: a fatura vence na data de emissão.
// Aos 15 e aos 30 dias (app_settings 'pay_reminders'.steps), se ainda houver valor em dívida, envia um email ao
// cliente, ao project manager do cliente ou aos dois (projects.pay_reminder_to), com o responsável do projeto em
// cópia oculta. Só faturas emitidas a partir de 'from', não arquivadas, sem "Não enviar lembretes" (reminders_paused).
// Pagamento parcial: o email fala só do que falta. Se o primeiro lembrete já ficou para trás, envia só o mais recente.
// Usa a chave do Resend (RESEND_API_KEY) e o remetente de Definições → NPS. Sem eles, regista "por configurar".
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY") ?? "";
const db = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const todayKey = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Lisbon" });
const addDays = (k: string, n: number) => { const d = new Date(k + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const isMail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const eur = (v: number, lang: string) => new Intl.NumberFormat(lang === "en" ? "en-IE" : "pt-PT", { style: "currency", currency: "EUR" }).format(v);
const dmy = (k: string) => `${k.slice(8, 10)}/${k.slice(5, 7)}/${k.slice(0, 4)}`;

// Valor em dívida com IVA: proporção do líquido por pagar aplicada ao total da fatura
function owedOf(i: any) {
  const net = Number(i.amount || 0), paid = Number(i.amount_paid || 0), gross = Number(i.gross_amount || 0) || net;
  if (net - paid <= 0.5) return 0;
  return Math.round(gross * (net - paid) / (net || 1) * 100) / 100;
}

function emailFor(o: { lang: string; step: number; last: boolean; inv: any; owed: number; total: number; project: string; iban: string; sender: string }) {
  const { lang, inv, owed, total, project, iban, sender } = o;
  const partial = owed < total - 0.5;
  const firm = o.last;
  const pt = {
    subject: `${firm ? "2.º lembrete" : "Lembrete"}: fatura ${inv.invoice_number} — ${project || "NOVA Associates"}`,
    hello: "Olá,",
    body: firm
      ? `A fatura ${inv.invoice_number}, emitida a ${dmy(inv.issue_date)}, continua por pagar há ${o.step} dias. Agradecemos que regularize o pagamento com a maior brevidade.`
      : `Lembramos que a fatura ${inv.invoice_number}, emitida a ${dmy(inv.issue_date)}${project ? ` (${project})` : ""}, ainda se encontra por pagar.`,
    rows: [["Fatura", inv.invoice_number], ["Data", dmy(inv.issue_date)], ["Total", eur(total, "pt")], ...(partial ? [["Já recebido", eur(total - owed, "pt")]] : []), ["Em dívida", eur(owed, "pt")], ...(iban ? [["IBAN", iban]] : [])],
    paid: "Se já efetuou o pagamento, por favor ignore esta mensagem e aceite o nosso obrigado.",
    q: "Para qualquer questão, basta responder a este email.",
    bye: "Com os melhores cumprimentos,",
  };
  const en = {
    subject: `${firm ? "Second reminder" : "Reminder"}: invoice ${inv.invoice_number} — ${project || "NOVA Associates"}`,
    hello: "Hello,",
    body: firm
      ? `Invoice ${inv.invoice_number}, issued on ${dmy(inv.issue_date)}, has been outstanding for ${o.step} days. We kindly ask you to settle it as soon as possible.`
      : `This is a friendly reminder that invoice ${inv.invoice_number}, issued on ${dmy(inv.issue_date)}${project ? ` (${project})` : ""}, is still outstanding.`,
    rows: [["Invoice", inv.invoice_number], ["Date", dmy(inv.issue_date)], ["Total", eur(total, "en")], ...(partial ? [["Already received", eur(total - owed, "en")]] : []), ["Amount due", eur(owed, "en")], ...(iban ? [["IBAN", iban]] : [])],
    paid: "If you have already paid, please disregard this message, and thank you.",
    q: "If you have any questions, simply reply to this email.",
    bye: "Kind regards,",
  };
  const L = lang === "en" ? en : pt;
  const font = "-apple-system,Segoe UI,Helvetica,Arial,sans-serif";
  const html = `<!doctype html><html lang="${lang}"><body style="margin:0;background:#F7F7F5;padding:24px 12px;font:15px/1.5 ${font};color:#1B1A19">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E4E3DE;border-radius:10px"><tr><td style="padding:28px">
<div style="font-weight:700;letter-spacing:.14em;color:#714D79;font-size:13px">NOVA ASSOCIATES</div>
<p style="margin:20px 0 8px">${L.hello}</p><p style="margin:0 0 16px">${esc(L.body)}</p>
<table role="presentation" style="border-collapse:collapse;width:100%;margin:0 0 16px">${L.rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#6B6660;border-top:1px solid #EEEDE8">${esc(k)}</td><td style="padding:6px 0;text-align:right;font-weight:600;border-top:1px solid #EEEDE8">${esc(v)}</td></tr>`).join("")}</table>
<p style="margin:0 0 8px;color:#6B6660;font-size:13.5px">${L.paid} ${L.q}</p>
<p style="margin:20px 0 0">${L.bye}<br>${esc(sender)}</p></td></tr></table></body></html>`;
  const text = `${L.hello}\n\n${L.body}\n\n${L.rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${L.paid} ${L.q}\n\n${L.bye}\n${sender}`;
  return { subject: L.subject, html, text };
}

async function tick() {
  const [cfgR, npsR] = await Promise.all([
    db.from("app_settings").select("value").eq("key", "pay_reminders").maybeSingle(),
    db.from("app_settings").select("value").eq("key", "nps").maybeSingle(),
  ]);
  const cfg = { active: true, steps: [15, 30], from: todayKey(), iban: "", ...(cfgR.data?.value || {}) };
  const nps = npsR.data?.value || {};
  const ready = !!RESEND && /@/.test(nps.from_email || "");
  const out: any = { last_run: new Date().toISOString(), ready, resend_key: !!RESEND, sent: 0, skipped: 0, errors: 0, waiting: 0 };
  if (!cfg.active) { out.inactive = true; return out; }
  const steps = [...(cfg.steps || [15, 30])].map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  const today = todayKey();
  const [inv, rem, pr, cl, ents, pms, tm] = await Promise.all([
    db.from("invoices").select("id, project_id, invoice_number, amount, amount_paid, gross_amount, issue_date, status, doc_type, customer_nif, archived_at, reminders_paused")
      .is("archived_at", null).gte("issue_date", cfg.from),
    db.from("invoice_reminders").select("invoice_id, step"),
    db.from("projects").select("id, name, client_id, owner_id, pm_id, pay_reminder_to"),
    db.from("clients").select("id, name, email, language"),
    db.from("client_entities").select("client_id, nif"),
    db.from("client_pms").select("id, email"),
    db.from("team_members").select("id, email"),
  ]);
  for (const r of [inv, rem, pr, cl]) if (r.error) throw r.error;
  const done = new Set((rem.data || []).map((x: any) => `${x.invoice_id}:${x.step}`));
  const projBy = Object.fromEntries((pr.data || []).map((p: any) => [p.id, p]));
  const clBy = Object.fromEntries((cl.data || []).map((c: any) => [c.id, c]));
  const clByNif: Record<string, string> = {};
  (ents.data || []).forEach((e: any) => { if (e.nif) clByNif[String(e.nif).replace(/\s/g, "")] = e.client_id; });
  const pmBy = Object.fromEntries((pms.data || []).map((p: any) => [p.id, p]));
  const tmBy = Object.fromEntries((tm.data || []).map((m: any) => [m.id, m]));
  for (const i of inv.data || []) {
    if (i.reminders_paused || i.status === "cancelled" || /^(NC|ND|RC|RG)$/i.test(i.doc_type || "") || !i.issue_date) continue;
    const owed = owedOf(i);
    if (owed <= 0) continue;
    const dueSteps = steps.filter((s) => addDays(i.issue_date, s) <= today && !done.has(`${i.id}:${s}`));
    if (!dueSteps.length) continue;
    const step = dueSteps[dueSteps.length - 1];
    // os lembretes anteriores que ficaram para trás não saem (só o mais recente)
    const skip = dueSteps.slice(0, -1);
    if (!ready) { out.waiting++; continue; }
    const p = projBy[i.project_id] || null;
    const client = clBy[p?.client_id] || clBy[clByNif[String(i.customer_nif || "").replace(/\s/g, "")]] || null;
    const pm = p?.pm_id ? pmBy[p.pm_id] : null;
    const mode = p?.pay_reminder_to || "client";
    const cEmail = String(client?.email || "").trim().toLowerCase(), pEmail = String(pm?.email || "").trim().toLowerCase();
    const to = [...new Set((mode === "pm" ? [pEmail || cEmail] : mode === "both" ? [cEmail, pEmail] : [cEmail]).filter(isMail))];
    const row: any = { invoice_id: i.id, step, owed };
    if (!to.length) { row.status = "error"; row.error = "Sem email do cliente/PM"; out.errors++; }
    else {
      const owner = p?.owner_id ? String(tmBy[p.owner_id]?.email || "").toLowerCase() : "";
      const m = emailFor({ lang: client?.language === "en" ? "en" : "pt", step, last: step === steps[steps.length - 1] && steps.length > 1, inv: i, owed,
        total: Number(i.gross_amount || 0) || Number(i.amount || 0), project: p?.name || "", iban: cfg.iban || "", sender: nps.sender_name || "NOVA Associates" });
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `${nps.sender_name || "NOVA Associates"} <${nps.from_email}>`, to, ...(isMail(owner) ? { bcc: [owner], reply_to: owner } : nps.reply_to ? { reply_to: nps.reply_to } : {}),
          subject: m.subject, html: m.html, text: m.text }),
      });
      if (r.ok) { row.status = "sent"; row.sent_to = to.join(", "); out.sent++; }
      else { row.status = "error"; row.error = `Resend ${r.status}: ${(await r.text()).slice(0, 300)}`; out.errors++; }
    }
    if (row.status === "error") { (out.problems ||= []).push(`${i.invoice_number}: ${row.error}`); continue; }   // volta a tentar amanhã
    await db.from("invoice_reminders").upsert(row, { onConflict: "invoice_id,step" });
    for (const s of skip) { await db.from("invoice_reminders").upsert({ invoice_id: i.id, step: s, status: "skipped", owed }, { onConflict: "invoice_id,step" }); out.skipped++; }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const out = await tick();
    await db.from("app_settings").upsert({ key: "pay_reminders_status", value: out, updated_at: new Date().toISOString() });
    return json({ ok: true, ...out });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
