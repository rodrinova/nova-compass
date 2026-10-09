// NOVA Compass — email das propostas de honorários pelo Outlook (Office 365)
// draft:     cria um rascunho na caixa de correio de quem está a usar a app, com o PDF da proposta anexado,
//            e devolve o link para o abrir no Outlook (a pessoa revê e carrega em Enviar).
// check:     vê se o rascunho de uma proposta já saiu; se saiu, a proposta passa a enviada com a hora do envio.
// check_all: o mesmo para todas as propostas com rascunho por enviar (a app chama ao abrir o Pipeline e a Hoje).
// Usa a mesma aplicação do Entra que a ms365-sync (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET), com mais uma
// permissão de aplicação: Mail.ReadWrite (consentimento do administrador). Ids imutáveis, para o rascunho manter
// o mesmo id depois de enviado.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TENANT = Deno.env.get("MS_TENANT_ID") ?? "";
const CLIENT = Deno.env.get("MS_CLIENT_ID") ?? "";
const SECRET = Deno.env.get("MS_CLIENT_SECRET") ?? "";
const GRAPH = "https://graph.microsoft.com/v1.0";
const TZ = "Europe/Lisbon";
const IMMUTABLE = { Prefer: 'IdType="ImmutableId"' };

const db = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: TZ });
const addDays = (k: string, n: number) => { const d = new Date(k + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

let token = "";
async function getToken() {
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("O Office 365 recusou a ligação: " + (j.error_description || j.error || r.status));
  token = j.access_token;
}
async function g(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(path.startsWith("http") ? path : GRAPH + path, {
    method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 204) return null;
  const t = await r.text();
  const j = t ? JSON.parse(t) : null;
  if (!r.ok) { const e: any = new Error(j?.error?.message || ("Office 365: erro " + r.status)); e.status = r.status; throw e; }
  return j;
}
const noPermission = (e: any) => e.status === 403 || e.status === 401 || /Access is denied|Authorization_RequestDenied|ErrorAccessDenied/i.test(e.message || "");

// Quem chama: só pessoas ativas da equipa; o rascunho fica na caixa de correio dela
async function caller(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const u = await db.auth.getUser(jwt);
  const email = String(u.data?.user?.email || "").toLowerCase();
  if (!email) return null;
  const m = await db.from("team_members").select("id, name, email").eq("active", true).ilike("email", email).maybeSingle();
  return m.data || null;
}

// Se o rascunho já saiu, a proposta passa a enviada (com a hora do envio)
async function checkOne(p: any) {
  const mail = p.content?.mail;
  if (!mail?.id || !mail?.by || mail.status !== "draft") return { id: p.id, status: mail?.status || null };
  let m: any;
  try { m = await g("GET", `/users/${encodeURIComponent(mail.by)}/messages/${encodeURIComponent(mail.id)}?$select=isDraft,sentDateTime`, undefined, IMMUTABLE); }
  catch (e: any) {
    if (e.status === 404) {
      const content = { ...p.content, mail: { ...mail, status: "gone" } };
      await db.from("fee_proposals").update({ content }).eq("id", p.id);
      return { id: p.id, status: "gone" };
    }
    throw e;
  }
  if (m.isDraft) return { id: p.id, status: "draft" };
  const sentAt = m.sentDateTime || new Date().toISOString();
  const day = dayKey(sentAt);
  const patch: Record<string, unknown> = {
    content: { ...p.content, mail: { ...mail, status: "sent", sent_at: sentAt } },
    sent_on: day, updated_at: new Date().toISOString(),
  };
  if (p.status === "draft") patch.status = "sent";
  if (!p.followup_on || p.followup_on < day) patch.followup_on = addDays(day, 7);
  if (p.probability == null) patch.probability = 40;
  await db.from("fee_proposals").update(patch).eq("id", p.id);
  if (p.plot_id) await db.from("land_plots").update({ status: "proposal" }).eq("id", p.plot_id).in("status", ["registered", "analysis", "presented"]);
  return { id: p.id, status: "sent", sent_at: sentAt };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!TENANT || !CLIENT || !SECRET) return json({ configured: false, error: "O Office 365 ainda não está ligado (Definições → Office 365)." });
  try {
    const who = await caller(req);
    if (!who) return json({ error: "Só a equipa NOVA pode usar isto." }, 403);
    const body = await req.json().catch(() => ({}));
    await getToken();

    if (body.action === "draft") {
      const pr = await db.from("fee_proposals").select("id, content").eq("id", body.proposal_id).maybeSingle();
      if (!pr.data) return json({ error: "Proposta não encontrada." }, 404);
      const mailbox = String(who.email).toLowerCase();
      const rec = (l: string[] = []) => l.map((a) => String(a).trim()).filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)).map((address) => ({ emailAddress: { address } }));
      let msg: any;
      try {
        msg = await g("POST", `/users/${encodeURIComponent(mailbox)}/messages`, {
          subject: String(body.subject || "").slice(0, 250),
          body: { contentType: "HTML", content: String(body.html || "") },
          toRecipients: rec(body.to), ccRecipients: rec(body.cc),
        }, IMMUTABLE);
      } catch (e: any) {
        if (noPermission(e)) return json({ error: "permission", detail: e.message });
        throw e;
      }
      // PDF: até ~3 MB vai direto; acima disso, por sessão de envio em partes
      const b64 = String(body.pdf || "");
      const name = String(body.filename || "Proposta.pdf");
      const size = Math.floor(b64.length * 3 / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
      if (b64) {
        const base = `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(msg.id)}/attachments`;
        if (size < 2_900_000) {
          await g("POST", base, { "@odata.type": "#microsoft.graph.fileAttachment", name, contentType: "application/pdf", contentBytes: b64 }, IMMUTABLE);
        } else {
          const ses = await g("POST", base + "/createUploadSession", { AttachmentItem: { attachmentType: "file", name, size } }, IMMUTABLE);
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const CH = 327680 * 9;
          for (let i = 0; i < bytes.length; i += CH) {
            const part = bytes.slice(i, Math.min(i + CH, bytes.length));
            const r = await fetch(ses.uploadUrl, { method: "PUT", headers: { "Content-Length": String(part.length), "Content-Range": `bytes ${i}-${i + part.length - 1}/${bytes.length}`, "Content-Type": "application/octet-stream" }, body: part });
            if (!r.ok && r.status !== 201 && r.status !== 200) throw new Error("Não foi possível anexar o PDF (" + r.status + ")");
          }
        }
      }
      const mail = { id: msg.id, link: msg.webLink || null, by: mailbox, by_member: who.id, created_at: new Date().toISOString(), status: "draft", subject: body.subject || "", to: body.to || [] };
      await db.from("fee_proposals").update({ content: { ...(pr.data.content || {}), mail } }).eq("id", pr.data.id);
      return json({ ok: true, webLink: msg.webLink, id: msg.id });
    }

    if (body.action === "check") {
      const pr = await db.from("fee_proposals").select("id, status, plot_id, followup_on, probability, content").eq("id", body.proposal_id).maybeSingle();
      if (!pr.data) return json({ error: "Proposta não encontrada." }, 404);
      return json(await checkOne(pr.data));
    }

    if (body.action === "check_all") {
      const pr = await db.from("fee_proposals").select("id, status, plot_id, followup_on, probability, content").eq("content->mail->>status", "draft");
      const out = [];
      for (const p of pr.data || []) { try { out.push(await checkOne(p)); } catch (e: any) { out.push({ id: p.id, error: e.message }); } }
      return json({ ok: true, results: out });
    }
    return json({ error: "Ação desconhecida." }, 400);
  } catch (e: any) {
    return json({ error: e.message || String(e) }, 200);
  }
});
