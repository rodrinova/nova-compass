// NOVA Compass — envio automático do NPS
// Corre de hora a hora (pg_cron, ver nps.sql). Em cada volta:
//   1. cria pedidos para as fases entregues ao cliente que cumprem as regras (app_settings 'nps')
//   2. envia os que chegaram à data (via Resend), manda um lembrete e dá por expirados os antigos
// Sem RESEND_API_KEY (Edge Functions → Secrets) ou sem remetente em Definições, só planeia:
// a app mostra os pedidos prontos e permite copiar o link.
// Ações da equipa (precisam de sessão de um membro ativo): send_now {id}, test {to}.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const RESEND = Deno.env.get("RESEND_API_KEY") ?? "";
const PAGE = "https://rodrinova.github.io/nova-compass/nps.html";
const MAX_PER_RUN = 25;

const db = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

const DEFAULTS = {
  active: true, from: "2026-09-30",
  types: ["Estudo Preliminar", "Estudo Prévio", "Licenciamento", "Execução", "Execução II"],
  client_revisions: true, closing: true,
  delay_days: 3, reminder_days: 5, expire_days: 30, cooldown_days: 60,
  sender_name: "NOVA Associates", from_email: "", reply_to: "",
};
type Cfg = typeof DEFAULTS;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const norm = (s: string | null | undefined) =>
  String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const todayKey = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Lisbon" });
const addDays = (k: string, n: number) => {
  const d = new Date(k + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function loadCfg(): Promise<Cfg> {
  const { data } = await db.from("app_settings").select("value").eq("key", "nps").maybeSingle();
  return { ...DEFAULTS, ...(data?.value ?? {}) };
}
const emailReady = (c: Cfg) => !!RESEND && /@/.test(c.from_email || "");

// ---------- 1. Planear ----------
async function plan(c: Cfg) {
  const [st, rq, pr, cl] = await Promise.all([
    db.from("project_stages")
      .select("id, project_id, status, delivery_date, revision_label, revision_kind, revision_cause, base_stage, stage_types(name)")
      .in("status", ["done", "completed", "review"]).gte("delivery_date", c.from),
    db.from("nps_requests").select("id, stage_id, project_id, kind, client_id, status, scheduled_for, sent_at"),
    db.from("projects").select("id, status, client_id, owner_id, archived_at"),
    db.from("clients").select("id, nps_opt_out"),
  ]);
  for (const r of [st, rq, pr, cl]) if (r.error) throw r.error;
  const reqs = rq.data!;
  const projects = new Map(pr.data!.map((p) => [p.id, p]));
  const optOut = new Set(cl.data!.filter((x) => x.nps_opt_out).map((x) => x.id));
  const haveStage = new Set(reqs.filter((q) => q.stage_id).map((q) => q.stage_id));
  const haveClose = new Set(reqs.filter((q) => q.kind === "fecho").map((q) => q.project_id));
  const types = new Set((c.types || []).map(norm));
  const rows: Record<string, unknown>[] = [];

  // Último contacto com cada cliente (enviado, ou agendado)
  const lastContact = (clientId: string) => {
    let last = "";
    for (const q of [...reqs, ...rows] as any[]) {
      if (q.client_id !== clientId || q.status === "skipped") continue;
      const k = q.sent_at ? String(q.sent_at).slice(0, 10) : q.scheduled_for;
      if (k > last) last = k;
    }
    return last;
  };
  const push = (row: Record<string, unknown>, cooldown: boolean) => {
    const cid = row.client_id as string | null;
    if (cid && optOut.has(cid)) { row.status = "skipped"; row.skip_reason = "opt_out"; }
    else if (cooldown && cid && c.cooldown_days > 0) {
      const last = lastContact(cid);
      if (last && addDays(last, c.cooldown_days) > (row.scheduled_for as string)) { row.status = "skipped"; row.skip_reason = "cooldown"; }
    }
    rows.push(row);
  };

  const stages = (st.data ?? []).sort((a, b) => String(a.delivery_date).localeCompare(String(b.delivery_date)));
  for (const s of stages as any[]) {
    if (haveStage.has(s.id)) continue;
    const p = projects.get(s.project_id);
    if (!p || p.archived_at) continue;
    const name: string = s.stage_types?.name ?? "";
    const n = norm(name);
    if (n.includes("oficio") || /assist|adjudica/.test(n)) continue;
    // "Base" também aparece como etiqueta de fases originais
    const isRev = s.base_stage === false || !!s.revision_kind || (s.base_stage == null && !!s.revision_label && !/^base$/i.test(s.revision_label));
    let kind: string;
    if (isRev) {
      if (!c.client_revisions || s.revision_cause !== "cliente" || s.revision_kind === "oficio") continue;
      kind = "revisao";
    } else {
      if (!types.has(n)) continue;
      kind = "fase";
    }
    push({ project_id: p.id, stage_id: s.id, kind, phase_name: name, client_id: p.client_id, owner_id: p.owner_id,
      status: "scheduled", scheduled_for: addDays(s.delivery_date, c.delay_days) }, true);
  }
  if (c.closing) {
    for (const p of pr.data!) {
      if (p.status !== "Done" || p.archived_at || haveClose.has(p.id)) continue;
      push({ project_id: p.id, kind: "fecho", phase_name: "Fecho do projeto", client_id: p.client_id, owner_id: p.owner_id,
        status: "scheduled", scheduled_for: addDays(todayKey(), c.delay_days) }, false);
    }
  }
  if (rows.length) {
    const { error } = await db.from("nps_requests").insert(rows);
    if (error) throw error;
  }
  return rows.length;
}

// ---------- 2. Enviar ----------
// Email nas duas línguas: primeiro a do cliente (ficha), logo a seguir a outra, para quem fale português ou inglês.
const PH_EN: Record<string, string> = {
  "estudo previo": "Schematic Design", "estudo preliminar": "Feasibility Study", "licenciamento": "Planning Application",
  "execucao": "Construction Documents", "execucao ii": "Construction Documents II", "especialidades": "Engineering Design",
  "levantamento topografico": "Topographic Survey", "pip": "Prior Information Request (PIP)", "propriedade horizontal": "Horizontal Property Regime",
  "comunicacao previa": "Prior Notice", "licenca de utilizacao": "Occupancy Permit", "fecho do projeto": "Project close-out"
};
const phaseEn = (n: string) => PH_EN[norm(n)] ?? n;
function emailFor(c: Cfg, q: any, reminder: boolean) {
  const first = q.clients?.language === "en" ? "en" : "pt";
  const project = q.projects?.name ?? "";
  const phase = q.phase_name ?? "";
  const link = (s?: number) => `${PAGE}?t=${q.token}${s == null ? "" : `&s=${s}`}`;
  const L = {
    pt: {
      hello: "Olá,",
      intro: q.kind === "fecho" ? `Concluímos o projeto ${project}. Obrigado pela confiança.`
        : q.kind === "revisao" ? `Entregámos recentemente a revisão de ${phase} do projeto ${project}.`
        : `Entregámos recentemente a fase ${phase} do projeto ${project}.`,
      help: "A sua opinião ajuda-nos a melhorar e demora menos de um minuto.",
      ask: "Numa escala de 0 a 10, qual a probabilidade de recomendar a NOVA a um amigo, colega ou parceiro?",
      lo: "Nada provável", hi: "Muito provável", thanks: "Obrigado",
      unsubQ: "Prefere não receber estes pedidos?", unsub: "Deixar de receber",
      subject: q.kind === "fecho" ? `Como foi trabalhar com a NOVA em ${project}?` : `Como correu: ${phase} — ${project}`,
      short: "Como correu?", remind: "Lembrete: ",
    },
    en: {
      hello: "Hello,",
      intro: q.kind === "fecho" ? `We have completed the ${project} project. Thank you for your trust.`
        : q.kind === "revisao" ? `We recently delivered the ${phaseEn(phase)} revision for ${project}.`
        : `We recently delivered the ${phaseEn(phase)} stage for ${project}.`,
      help: "Your opinion helps us improve and takes less than a minute.",
      ask: "On a scale of 0 to 10, how likely are you to recommend NOVA to a friend, colleague or partner?",
      lo: "Not likely", hi: "Very likely", thanks: "Thank you",
      unsubQ: "Prefer not to receive these requests?", unsub: "Unsubscribe",
      subject: q.kind === "fecho" ? `How was working with NOVA on ${project}?` : `How did it go: ${phaseEn(phase)} — ${project}`,
      short: "How did it go?", remind: "Reminder: ",
    },
  };
  const A = L[first], B = L[first === "pt" ? "en" : "pt"];
  const second = first === "pt" ? "en" : "pt";
  const subject = (reminder ? A.remind : "") + A.subject + " · " + B.short;
  const font = "-apple-system,Segoe UI,Helvetica,Arial,sans-serif";
  const cells = Array.from({ length: 11 }, (_, i) =>
    `<td style="padding:2px"><a href="${link(i)}" style="display:block;width:34px;height:34px;line-height:34px;text-align:center;border:1px solid #D3D1CA;border-radius:6px;color:#1B1A19;text-decoration:none;font:600 14px ${font}">${i}</a></td>`).join("");
  const html = `<!doctype html><html lang="${first}"><body style="margin:0;background:#F7F7F5;padding:24px 12px;font:15px/1.5 ${font};color:#1B1A19">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E4E3DE;border-radius:10px"><tr><td style="padding:28px">
<div style="font-weight:700;letter-spacing:.14em;color:#714D79;font-size:13px">NOVA ASSOCIATES</div>
<div lang="${first}">
<p style="margin:20px 0 8px">${A.hello}</p>
<p style="margin:0 0 12px">${esc(A.intro)} ${A.help}</p>
<p style="margin:0 0 4px;font-weight:600">${A.ask}</p>
</div>
<div lang="${second}" style="color:#6B6660;font-size:13.5px;margin:0 0 14px;padding-left:10px;border-left:2px solid #E4E3DE">
<p style="margin:0 0 2px">${B.hello} ${esc(B.intro)} ${B.help}</p>
<p style="margin:0;font-weight:600">${B.ask}</p>
</div>
<table role="presentation" style="border-collapse:collapse"><tr>${cells}</tr></table>
<table role="presentation" width="100%" style="max-width:420px;font-size:12px;color:#736D66"><tr><td>0 · ${A.lo} / ${B.lo}</td><td style="text-align:right">10 · ${A.hi} / ${B.hi}</td></tr></table>
<p style="margin:20px 0 0">${A.thanks} · ${B.thanks},<br>${esc(c.sender_name || "NOVA Associates")}</p>
</td></tr></table>
<p style="max-width:560px;margin:14px auto 0;font-size:12px;color:#736D66;text-align:center">${A.unsubQ} / ${B.unsubQ} <a href="${PAGE}?t=${q.token}&optout=1" style="color:#736D66">${A.unsub} / ${B.unsub}</a></p>
</body></html>`;
  const text = `${A.hello}\n\n${A.intro} ${A.help}\n\n${A.ask}\n${link()}\n\n---\n\n${B.hello}\n\n${B.intro} ${B.help}\n\n${B.ask}\n${link()}\n\n${A.unsub} / ${B.unsub}: ${PAGE}?t=${q.token}&optout=1`;
  return { subject, html, text };
}

async function sendEmail(c: Cfg, to: string | string[], m: { subject: string; html: string; text: string }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${c.sender_name || "NOVA Associates"} <${c.from_email}>`, to: Array.isArray(to) ? to : [to],
      subject: m.subject, html: m.html, text: m.text, ...(c.reply_to ? { reply_to: c.reply_to } : {}),
    }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

const SEL = "id, token, kind, phase_name, status, scheduled_for, sent_at, sent_to, reminder_sent_at, client_id, clients(email, language, nps_opt_out), projects(name, archived_at, nps_to, client_pms(email))";
// Destinatários: o cliente, o project manager do cliente (projects.pm_id) ou os dois (projects.nps_to)
function recipients(q: any): string[] {
  const c = String(q.clients?.email || "").trim(), pm = String(q.projects?.client_pms?.email || "").trim();
  const to = q.projects?.nps_to || "client";
  const list = to === "pm" ? [pm || c] : to === "both" ? [c, pm] : [c];
  return [...new Set(list.filter((e) => /^[^@\s]+@[^@\s]+$/.test(e)))];
}

async function deliver(c: Cfg, q: any, reminder: boolean) {
  const to = reminder && q.sent_to ? String(q.sent_to).split(/,\s*/).filter(Boolean) : recipients(q);
  if (!to.length) return false;
  try {
    await sendEmail(c, to, emailFor(c, q, reminder));
    const patch = reminder
      ? { reminder_sent_at: new Date().toISOString(), send_error: null }
      : { status: "sent", sent_at: new Date().toISOString(), sent_to: to.join(", "), send_error: null };
    await db.from("nps_requests").update(patch).eq("id", q.id);
    return true;
  } catch (e) {
    await db.from("nps_requests").update({ send_error: String((e as Error).message || e).slice(0, 500) }).eq("id", q.id);
    return false;
  }
}

async function sendDue(c: Cfg) {
  const out = { sent: 0, reminders: 0, expired: 0 };
  const now = Date.now();
  // expirados: sem resposta ao fim de expire_days
  const { data: open } = await db.from("nps_requests").select(SEL).eq("status", "sent");
  for (const q of (open ?? []) as any[]) {
    const age = (now - new Date(q.sent_at).getTime()) / 86400000;
    if (age >= c.expire_days) {
      await db.from("nps_requests").update({ status: "expired" }).eq("id", q.id); out.expired++;
    }
  }
  if (!emailReady(c)) return out;
  let budget = MAX_PER_RUN;
  const { data: due } = await db.from("nps_requests").select(SEL).eq("status", "scheduled").lte("scheduled_for", todayKey());
  for (const q of (due ?? []) as any[]) {
    if (budget <= 0) break;
    if (q.projects?.archived_at) continue;
    if (q.clients?.nps_opt_out) { await db.from("nps_requests").update({ status: "skipped", skip_reason: "opt_out" }).eq("id", q.id); continue; }
    if (await deliver(c, q, false)) { out.sent++; budget--; }
  }
  for (const q of (open ?? []) as any[]) {
    if (budget <= 0) break;
    const age = (now - new Date(q.sent_at).getTime()) / 86400000;
    if (q.reminder_sent_at || age < c.reminder_days || age >= c.expire_days || q.clients?.nps_opt_out) continue;
    if (await deliver(c, q, true)) { out.reminders++; budget--; }
  }
  return out;
}

async function isTeamMember(req: Request) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const u = createClient(SB_URL, SB_ANON || SB_SERVICE, { auth: { persistSession: false } });
  const { data } = await u.auth.getUser(auth.slice(7));
  const email = data?.user?.email;
  if (!email) return false;
  const { data: m } = await db.from("team_members").select("id").eq("active", true).ilike("email", email).limit(1);
  return !!m?.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "tick";
    const c = await loadCfg();
    if (action === "tick") {
      if (!c.active) return json({ ok: true, active: false });
      const planned = await plan(c);
      const sent = await sendDue(c);
      await db.from("app_settings").upsert({ key: "nps_status",
        value: { last_run: new Date().toISOString(), email_ready: emailReady(c), resend_key: !!RESEND, planned, ...sent },
        updated_at: new Date().toISOString() });
      return json({ ok: true, planned, ...sent, email_ready: emailReady(c) });
    }
    if (!(await isTeamMember(req))) return json({ ok: false, error: "Sem permissão" }, 403);
    if (action === "status") return json({ ok: true, email_ready: emailReady(c), resend_key: !!RESEND });
    if (!emailReady(c)) return json({ ok: false, error: RESEND ? "Falta o email do remetente em Definições → NPS." : "O envio de email ainda não está configurado (falta a chave do Resend no Supabase)." });
    if (action === "send_now") {
      const { data: q } = await db.from("nps_requests").select(SEL).eq("id", body.id).maybeSingle();
      if (!q) return json({ ok: false, error: "Pedido não encontrado" }, 404);
      if ((q as any).status === "answered") return json({ ok: false, error: "O cliente já respondeu." });
      if (!recipients(q).length) return json({ ok: false, error: "O cliente (ou o PM) não tem email na ficha." });
      const reminder = (q as any).status === "sent";
      const ok = await deliver(c, q, reminder);
      return json({ ok, reminder });
    }
    if (action === "test") {
      const to = String(body.to || "");
      if (!/^[^@\s]+@[^@\s]+$/.test(to)) return json({ ok: false, error: "Email inválido" }, 400);
      await sendEmail(c, to, emailFor(c, { token: "exemplo", kind: "fase", phase_name: "Estudo Prévio", projects: { name: "Projeto de exemplo" }, clients: { language: "pt" } }, false));
      return json({ ok: true });
    }
    return json({ ok: false, error: "Ação desconhecida" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
