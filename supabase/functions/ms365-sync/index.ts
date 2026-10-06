// NOVA Compass — sincronização com o Office 365 (calendários Outlook/Teams)
// Corre de 10 em 10 minutos (pg_cron, ver office365.sql), com "Sincronizar agora" (Definições → Office 365) e logo
// que se grava ou apaga um marco na app (reuniões online ficam prontas em segundos, já a gravar e transcrever).
// Para cada pessoa ativa da equipa (pelo email @novassociates.com):
//   1. ESCREVE no calendário principal dela (o que o Teams e o iPhone mostram), com a categoria "NOVA Compass":
//      - marcos e entregas de que é responsável (não as fases de projeto, nem prazos a controlar);
//      - marcos com várias pessoas: um só evento partilhado (organiza quem criou o marco na app, os outros são
//        convidados); com a opção "Reunião online" leva link Teams (guardado em ms_event_links.join_url);
//      - lembretes do Investment Intelligence: apresentação sem resposta ao fim de 7 dias (para o responsável da oportunidade).
//      A app é a fonte: o que muda na app atualiza o evento; o que sai da app é apagado do calendário.
//   2. LÊ o calendário dela (reuniões Teams e eventos do Outlook) para a Agenda e a Hoje da app.
//      Eventos privados ficam só como "Ocupado".
//   3. TRANSCRIÇÕES: depois de cada reunião Teams organizada por alguém da equipa, lê a transcrição (se houve) e
//      arquiva-a como ata do projeto ou da categoria do marco (reuniões do Outlook: projeto cujo código/nome está no
//      assunto; senão fica por arquivar e a Hoje de quem organizou pede o projeto ou a categoria).
//      Precisa ainda das permissões OnlineMeetings.Read.All, OnlineMeetingTranscript.Read.All e User.Read.All e de uma
//      Application Access Policy do Teams (ver Definições → Office 365). Sem elas, o calendário continua a funcionar.
//   5. AUSÊNCIAS (férias, doença, faltas, formação): no calendário da própria pessoa, dia inteiro, como "Fora do
//      escritório" (o Teams mostra-a fora e quem marca reuniões vê). A doença fica só como "Ausente" (sem motivo).
//   6. DAYBREAK: cria uma reunião Teams fixa para a reunião diária das 8:40 (só o link, sem evento no calendário;
//      app_settings 'daybreak'.join_url). Precisa de OnlineMeetings.ReadWrite.All e da política do Teams.
//   4. GRAVAÇÃO AUTOMÁTICA: nas reuniões Teams futuras organizadas pela equipa (14 dias), liga "Gravar e transcrever
//      automaticamente" (recordAutomatically), para a transcrição arrancar sozinha. Precisa de OnlineMeetings.ReadWrite.All.
// Precisa (Edge Functions → Secrets): MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET — uma aplicação registada
// no Entra ID com as permissões de aplicação Calendars.ReadWrite e MailboxSettings.ReadWrite (consentimento do
// administrador). Sem estes segredos, só regista "por configurar" e sai.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TENANT = Deno.env.get("MS_TENANT_ID") ?? "";
const CLIENT = Deno.env.get("MS_CLIENT_ID") ?? "";
const SECRET = Deno.env.get("MS_CLIENT_SECRET") ?? "";
const APP_URL = "https://rodrinova.github.io/nova-compass/";
const CATEGORY = "NOVA Compass";
const TZ = "Europe/Lisbon";
const GRAPH = "https://graph.microsoft.com/v1.0";
const READ_BACK = 30, READ_AHEAD = 120, WRITE_BACK = 7, WRITE_AHEAD = 180, RADAR_DAYS = 7;
const LOCK_KEY = "ms365_lock", LOCK_MS = 120e3;   // uma sincronização de cada vez (cron + "ao gravar" na app)
const TRANSCRIPT_DAYS = 3, TRANSCRIPT_WAIT_H = 24;   // procura nos 3 dias seguintes; sem transcrição ao fim de 24 h, desiste

const db = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const todayKey = () => new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
const addDays = (k: string, n: number) => {
  const d = new Date(k + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
async function sha(s: string) {
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function saveStatus(v: Record<string, unknown>) {
  await db.from("app_settings").upsert({ key: "ms365", value: { ...v, at: new Date().toISOString() }, updated_at: new Date().toISOString() });
}

// ---------- Microsoft Graph ----------
let token = "";
async function getToken() {
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Office 365 recusou a ligação: " + (j.error_description || j.error || r.status));
  token = j.access_token;
}
async function g(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(path.startsWith("http") ? path : GRAPH + path, {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 || r.status === 503) { await new Promise((res) => setTimeout(res, 1000 * Number(r.headers.get("Retry-After") || 2 ** attempt))); continue; }
    if (r.status === 204 || r.status === 202) return null;
    const t = await r.text();
    if (r.ok && !(r.headers.get("content-type") || "").includes("json")) return t;   // ex.: transcrição em text/vtt
    let j: any = null;
    try { j = t ? JSON.parse(t) : null; } catch (_) { /* resposta sem JSON */ }
    if (!r.ok) { const e: any = new Error(j?.error?.message || `Graph ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  throw new Error("Office 365 ocupado — volta a tentar daqui a pouco");
}

// ---------- O que a app quer em cada calendário ----------
type Want = { key: string; member: string; payload: Record<string, unknown> };
async function desired(members: any[]) {
  const from = addDays(todayKey(), -WRITE_BACK), to = addDays(todayKey(), WRITE_AHEAD);
  const [ms, ow, ty, pr, pres, plots, invs, gu, ab] = await Promise.all([
    db.from("project_milestones").select("id, project_id, type_id, title, event_date, all_day, start_time, end_time, location, notes, done, auto_kind, created_by, teams_link").gte("event_date", from).lte("event_date", to),
    db.from("milestone_owners").select("milestone_id, member_id"),
    db.from("milestone_types").select("id, name, is_deadline"),
    db.from("projects").select("id, name, code"),
    db.from("land_presentations").select("id, plot_id, investor_id, contact_name, presented_on, status"),
    db.from("land_plots").select("id, name, scout_id, status"),
    db.from("investors").select("id, name"),
    db.from("milestone_guests").select("milestone_id, name, email"),
    db.from("absences").select("id, member_id, kind, subkind, start_date, end_date").lte("start_date", to).gte("end_date", from),
  ]);
  for (const r of [ms, ow, ty, pr]) if (r.error) throw r.error;
  const types = Object.fromEntries((ty.data || []).map((t: any) => [t.id, t]));
  const projs = Object.fromEntries((pr.data || []).map((p: any) => [p.id, p]));
  const byM: Record<string, string[]> = {};
  (ow.data || []).forEach((o: any) => (byM[o.milestone_id] = byM[o.milestone_id] || []).push(o.member_id));
  const email = Object.fromEntries(members.map((m) => [m.id, m]));
  const teamMail = new Set(members.map((m) => String(m.email).toLowerCase()));
  const guestsBy: Record<string, any[]> = {};
  (gu.data || []).forEach((x: any) => { const e = String(x.email || "").trim().toLowerCase(); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !teamMail.has(e)) (guestsBy[x.milestone_id] = guestsBy[x.milestone_id] || []).push({ ...x, email: e }); });
  const out: Want[] = [];
  // Com convidados de fora, o link da app (só para a equipa) dá lugar ao aviso de proteção de dados
  const body = (lines: string[], foot = "") => ({ contentType: "HTML", content: lines.filter(Boolean).map((l) => `<p>${l}</p>`).join("") + (foot || `<p><a href="${APP_URL}">Abrir no NOVA Compass</a></p>`) });
  for (const m of ms.data || []) {
    const t = types[m.type_id];
    if (m.done || t?.is_deadline) continue;                       // prazos a controlar ficam nos avisos da app
    const owners = (byM[m.id] || []).filter((id) => email[id]);
    if (!owners.length) continue;
    const p = projs[m.project_id];
    const subject = [m.title, p ? (p.code ? p.code + " · " : "") + p.name : null].filter(Boolean).join(" — ");
    const timed = !m.all_day && !!m.start_time;
    const start = timed ? `${m.event_date}T${String(m.start_time).slice(0, 5)}:00` : `${m.event_date}T00:00:00`;
    let end = timed ? (m.end_time ? `${m.event_date}T${String(m.end_time).slice(0, 5)}:00` : null) : `${addDays(m.event_date, 1)}T00:00:00`;
    if (timed && !end) { const [h, mi] = String(m.start_time).split(":").map(Number); const e = h * 60 + mi + 60; end = `${m.event_date}T${String(Math.min(23, Math.floor(e / 60))).padStart(2, "0")}:${String(e % 60).padStart(2, "0")}:00`; }
    const meeting = timed && !!m.teams_link;
    const guests = guestsBy[m.id] || [];
    const base = {
      subject, body: body([esc(t?.name || (m.auto_kind === "delivery" ? "Entrega" : "Marco")), m.notes ? esc(m.notes) : ""], guests.length ? gdpr(meeting) : ""),
      start: { dateTime: start, timeZone: TZ }, end: { dateTime: end, timeZone: TZ }, isAllDay: !timed,
      location: m.location ? { displayName: m.location } : undefined, categories: [CATEGORY],
      showAs: timed ? "busy" : "free", isReminderOn: timed,
    };
    // Um só evento partilhado: organiza quem criou o marco na app (se não estiver na equipa ligada, o 1.º responsável
    // por nome); os outros responsáveis são convidados — aparece no calendário de todos e as alterações chegam a todos.
    // Com a opção "Reunião online" (teams_link), leva link Teams.
    const sorted = [...owners].sort((a, b) => String(email[a].name).localeCompare(String(email[b].name), "pt"));
    const org = m.created_by && email[m.created_by] ? m.created_by : sorted[0];
    const rest = sorted.filter((id) => id !== org);
    // Convidados de fora (cliente, contactos, qualquer email) recebem o convite do Outlook e podem responder
    const attendees = [
      ...rest.map((id) => ({ emailAddress: { address: email[id].email, name: email[id].name }, type: "required" })),
      ...guests.map((x) => ({ emailAddress: { address: x.email, ...(x.name ? { name: x.name } : {}) }, type: "required" })),
    ];
    out.push({ key: `m:${m.id}`, member: org, payload: { ...base,
      ...(meeting ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
      ...(attendees.length ? { attendees, responseRequested: guests.length > 0 } : {}) } });
  }
  // Lembretes do Investment Intelligence: 7 dias depois de uma apresentação ainda sem resposta
  const plotBy = Object.fromEntries((plots.data || []).map((p: any) => [p.id, p]));
  const invBy = Object.fromEntries((invs.data || []).map((i: any) => [i.id, i]));
  for (const x of pres.data || []) {
    const pl = plotBy[x.plot_id];
    if (x.status !== "presented" || !pl?.scout_id || !email[pl.scout_id]) continue;
    const day = addDays(x.presented_on, RADAR_DAYS);
    if (day < from || day > to) continue;
    const who = x.investor_id ? invBy[x.investor_id]?.name : x.contact_name;
    out.push({ key: `r:${x.id}`, member: pl.scout_id, payload: {
      subject: `Investment Intelligence · sem resposta — ${pl.name} → ${who || "contacto"}`,
      body: body([`Apresentada a ${esc(x.presented_on)}. Faz o seguimento e regista a resposta na app.`]),
      start: { dateTime: `${day}T00:00:00`, timeZone: TZ }, end: { dateTime: `${addDays(day, 1)}T00:00:00`, timeZone: TZ },
      isAllDay: true, categories: [CATEGORY], showAs: "free", isReminderOn: false } });
  }
  // Ausências: dia inteiro, "Fora do escritório", no calendário de quem está fora
  const ABS: Record<string, string> = { vacation: "Férias", sick: "Ausente", justified: "Ausente", training: "Formação" };
  for (const a of ab.data || []) {
    if (!email[a.member_id]) continue;
    out.push({ key: `a:${a.id}`, member: a.member_id, payload: {
      subject: `${ABS[a.kind] || "Ausente"} — fora do escritório`,
      body: body(["Marcado no NOVA Compass (Ausências)."]),
      start: { dateTime: `${a.start_date}T00:00:00`, timeZone: TZ }, end: { dateTime: `${addDays(a.end_date, 1)}T00:00:00`, timeZone: TZ },
      isAllDay: true, categories: [CATEGORY], showAs: "oof", isReminderOn: false, sensitivity: a.kind === "sick" ? "private" : "normal" } });
  }
  return out;
}

// Daybreak: uma reunião Teams fixa (só o link; não aparece em nenhum calendário). Organiza o 1.º sócio por nome.
// As reuniões criadas assim expiram 60 dias depois do fim sem uso: o fim fica a 1 ano e renova-se 30 dias antes.
async function ensureDaybreak(members: any[]) {
  const r = await db.from("app_settings").select("value").eq("key", "daybreak").maybeSingle();
  const cur = r.data?.value || {};
  if (cur.join_url && cur.manual) return { ok: true, manual: true };
  if (cur.join_url && cur.expires && cur.expires > addDays(todayKey(), 30)) return { ok: true };
  const org = [...members].sort((a, b) => String(a.name).localeCompare(String(b.name), "pt"))[0];
  if (!org) return { ok: false };
  const uid = await userId(org.email);
  const end = addDays(todayKey(), 365);
  const om = await g("POST", `/users/${uid}/onlineMeetings`, {
    subject: "Daybreak — NOVA Associates",
    startDateTime: lisbonToUtc(todayKey(), "08:40").toISOString(), endDateTime: lisbonToUtc(end, "09:00").toISOString(),
    lobbyBypassSettings: { scope: "organization", isDialInBypassEnabled: true }, allowedPresenters: "everyone",
  });
  await db.from("app_settings").upsert({ key: "daybreak", value: { join_url: om.joinWebUrl, meeting_id: om.id, organizer: org.id, expires: end, at: new Date().toISOString() }, updated_at: new Date().toISOString() });
  return { ok: true, created: true };
}

// Aviso RGPD que segue no convite enviado a pessoas de fora da equipa
function gdpr(meeting: boolean) {
  return `<hr><p style="font-size:12px;color:#666">Proteção de dados: a NOVA Associates trata o seu nome e email apenas para organizar esta reunião e o acompanhamento do projeto, nos termos do RGPD.` +
    (meeting ? ` A reunião será gravada e transcrita automaticamente para a elaboração da ata; o Teams avisa no início e pode opor-se a qualquer momento.` : ``) +
    ` Para aceder, corrigir ou apagar os seus dados, responda a este convite.</p>` +
    `<p style="font-size:12px;color:#666">Data protection: NOVA Associates processes your name and email only to organise this meeting and follow up on the project, under the GDPR.` +
    (meeting ? ` The meeting will be recorded and transcribed automatically to prepare the minutes; Teams notifies at the start and you may object at any time.` : ``) +
    ` To access, correct or delete your data, reply to this invitation.</p>`;
}

async function ensureCategory(upn: string) {
  try {
    const r = await g("GET", `/users/${encodeURIComponent(upn)}/outlook/masterCategories`);
    if (!(r?.value || []).some((c: any) => c.displayName === CATEGORY))
      await g("POST", `/users/${encodeURIComponent(upn)}/outlook/masterCategories`, { displayName: CATEGORY, color: "preset8" });
  } catch (_) { /* sem MailboxSettings: os eventos ficam sem cor própria, mas sincronizam */ }
}

// ---------- Uma pessoa ----------
async function syncMember(m: any, wants: Want[], links: any[], keep: Set<string>) {
  const upn = encodeURIComponent(m.email);
  const res = { name: m.name, written: 0, deleted: 0, read: 0, cancelled: 0, ours: 0, error: null as string | null };
  await ensureCategory(m.email);
  // 1. Escrever
  const mine = wants.filter((w) => w.member === m.id);
  const myLinks = links.filter((l) => l.member_id === m.id);
  for (const w of mine) {
    const hash = await sha(JSON.stringify(w.payload));
    const l = myLinks.find((x) => x.source_key === w.key);
    try {
      if (l && l.hash === hash && !((w.payload as any).isOnlineMeeting && !l.join_url)) continue;   // reunião sem link guardado: volta a escrever
      if (l) {
        let c: any;
        try { c = await g("PATCH", `/users/${upn}/events/${l.ms_event_id}`, w.payload); }
        catch (e: any) { if (e.status !== 404) throw e; c = await g("POST", `/users/${upn}/events`, w.payload); l.ms_event_id = c.id; l.ical_uid = c.iCalUId; }
        l.join_url = c?.onlineMeeting?.joinUrl || null;
        await db.from("ms_event_links").update({ hash, ms_event_id: l.ms_event_id, ical_uid: l.ical_uid, join_url: l.join_url, updated_at: new Date().toISOString() }).eq("member_id", m.id).eq("source_key", w.key);
      } else {
        const c = await g("POST", `/users/${upn}/events`, w.payload);
        await db.from("ms_event_links").upsert({ member_id: m.id, source_key: w.key, ms_event_id: c.id, ical_uid: c.iCalUId, join_url: c?.onlineMeeting?.joinUrl || null, hash, updated_at: new Date().toISOString() });
        links.push({ member_id: m.id, source_key: w.key, ms_event_id: c.id, ical_uid: c.iCalUId, join_url: c?.onlineMeeting?.joinUrl || null, hash });
      }
      res.written++;
    } catch (e: any) { res.error = e.message; }
  }
  // O que saiu da app sai do calendário; marcos realizados ou já passados ficam como histórico (sem cancelar a quem foi).
  // Primeiro tenta cancelar (os convidados recebem o aviso); se não houver convidados, apaga.
  for (const l of myLinks.filter((x) => !mine.some((w) => w.key === x.source_key) && !keep.has(x.source_key))) {
    try { await g("POST", `/users/${upn}/events/${l.ms_event_id}/cancel`, { comment: "Reunião cancelada." }); }
    catch (_) {
      try { await g("DELETE", `/users/${upn}/events/${l.ms_event_id}`); } catch (e: any) { if (e.status !== 404) { res.error = e.message; continue; } }
    }
    await db.from("ms_event_links").delete().eq("member_id", m.id).eq("source_key", l.source_key);
    res.deleted++;
  }
  // 2. Ler
  const start = new Date(addDays(todayKey(), -READ_BACK) + "T00:00:00Z").toISOString();
  const end = new Date(addDays(todayKey(), READ_AHEAD) + "T00:00:00Z").toISOString();
  const ours = new Set(links.map((l) => l.ical_uid).filter(Boolean));
  const rows: any[] = [];
  let url: string | null = `/users/${upn}/calendarView?startDateTime=${start}&endDateTime=${end}&$top=200&$select=id,iCalUId,subject,start,end,isAllDay,location,isOnlineMeeting,onlineMeeting,showAs,sensitivity,organizer,attendees,webLink,categories,isCancelled`;
  while (url) {
    const r: any = await g("GET", url, undefined, { Prefer: `outlook.timezone="UTC"` });
    for (const e of r.value || []) {
      if (e.isCancelled) { res.cancelled++; continue; }
      if ((e.categories || []).includes(CATEGORY) || ours.has(e.iCalUId)) { res.ours++; continue; }   // o que a app escreveu não volta a entrar
      const priv = e.sensitivity === "private" || e.sensitivity === "confidential";
      rows.push({ member_id: m.id, ms_id: e.id, ical_uid: e.iCalUId, subject: priv ? null : e.subject,
        start_at: e.start.dateTime + "Z", end_at: e.end?.dateTime ? e.end.dateTime + "Z" : null, all_day: !!e.isAllDay,
        location: priv ? null : (e.location?.displayName || null), is_online: !!e.isOnlineMeeting, join_url: priv ? null : (e.onlineMeeting?.joinUrl || null),
        show_as: e.showAs, is_private: priv, organizer: priv ? null : (e.organizer?.emailAddress?.name || null), web_link: e.webLink, synced_at: new Date().toISOString(),
        organizer_email: (e.organizer?.emailAddress?.address || "").toLowerCase() || null,
        attendee_emails: priv ? [] : (e.attendees || []).map((a: any) => String(a.emailAddress?.address || "").toLowerCase()).filter(Boolean) });
    }
    url = r["@odata.nextLink"] || null;
  }
  await db.from("ms_events").delete().eq("member_id", m.id);
  for (let i = 0; i < rows.length; i += 200) { const r = await db.from("ms_events").insert(rows.slice(i, i + 200)); if (r.error) throw r.error; }
  res.read = rows.length;
  return res;
}

// ---------- Transcrições → atas ----------
// ID do utilizador no Entra (as reuniões online pedem-no); sem User.Read.All, tenta com o email
const uidCache: Record<string, string> = {};
async function userId(email: string) {
  if (uidCache[email]) return uidCache[email];
  try { uidCache[email] = (await g("GET", `/users/${encodeURIComponent(email)}?$select=id`))?.id || email; } catch (_) { uidCache[email] = email; }
  return uidCache[email];
}
// Gravação e transcrição automáticas nas reuniões Teams futuras organizadas pela equipa
const AUTOREC_DAYS = 14;
async function syncAutoRecord(members: any[], links: any[]) {
  const res = { set: 0, error: null as string | null };
  const now = Date.now(), nowIso = new Date(now).toISOString(), until = new Date(now + AUTOREC_DAYS * 864e5).toISOString();
  const byEmail = Object.fromEntries(members.map((m) => [String(m.email).toLowerCase(), m]));
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  const cand = new Map<string, any>();
  const ev = await db.from("ms_events").select("ical_uid, subject, start_at, join_url, organizer_email")
    .eq("is_online", true).not("join_url", "is", null).gte("start_at", nowIso).lte("start_at", until);
  for (const e of ev.data || []) { const org = byEmail[e.organizer_email || ""]; if (org && e.ical_uid) cand.set(e.ical_uid, { ...e, org }); }
  const ml = links.filter((l: any) => l.source_key?.startsWith("m:") && l.join_url && l.ical_uid && byId[l.member_id]);
  if (ml.length) {
    const mr = await db.from("project_milestones").select("id, title, event_date, start_time").in("id", ml.map((l: any) => l.source_key.slice(2)));
    const mBy = Object.fromEntries((mr.data || []).map((m: any) => [m.id, m]));
    for (const l of ml) {
      const m = mBy[l.source_key.slice(2)];
      if (!m?.start_time) continue;
      const st = lisbonToUtc(m.event_date, String(m.start_time)).toISOString();
      if (st >= nowIso && st <= until) cand.set(l.ical_uid, { ical_uid: l.ical_uid, subject: m.title, start_at: st, join_url: l.join_url, org: byId[l.member_id] });
    }
  }
  if (!cand.size) return res;
  const seen = await db.from("ms_autorecord").select("ical_uid, status").in("ical_uid", [...cand.keys()]);
  const done = new Set((seen.data || []).filter((x: any) => x.status === "ok").map((x: any) => x.ical_uid));
  for (const c of cand.values()) {
    if (done.has(c.ical_uid)) continue;
    const row: any = { ical_uid: c.ical_uid, subject: c.subject, start_at: c.start_at, status: "ok", error: null, set_at: nowIso };
    try {
      const uid = await userId(c.org.email);
      const om = (await g("GET", `/users/${uid}/onlineMeetings?$filter=${encodeURIComponent(`JoinWebUrl eq '${c.join_url}'`)}`))?.value?.[0];
      if (!om) throw new Error("Reunião não encontrada no Teams");
      if (!om.recordAutomatically) await g("PATCH", `/users/${uid}/onlineMeetings/${om.id}`, { recordAutomatically: true });
      res.set++;
    } catch (e: any) {
      row.status = "error"; row.error = e.message;
      res.error = e.status === 403 || e.status === 401
        ? "Sem permissão para ligar a gravação automática: falta OnlineMeetings.ReadWrite.All no Entra (Definições → Office 365)."
        : e.message;
      await db.from("ms_autorecord").upsert(row);
      if (e.status === 403 || e.status === 401) break;
      continue;
    }
    await db.from("ms_autorecord").upsert(row);
  }
  return res;
}
// Hora de Lisboa (data + HH:MM) → instante UTC
function lisbonToUtc(date: string, time: string) {
  const guess = new Date(`${date}T${time.slice(0, 5)}:00Z`);
  const local = new Date(guess.toLocaleString("sv-SE", { timeZone: TZ }).replace(" ", "T") + "Z");
  return new Date(guess.getTime() - (local.getTime() - guess.getTime()));
}
const lisbon = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString("pt-PT", { timeZone: TZ, ...o });
// WebVTT do Teams (<v Nome>texto</v>) → "[mm:ss] Nome: texto", juntando falas seguidas da mesma pessoa
function vttToText(vtt: string) {
  const out: { who: string; ts: string; txt: string }[] = [];
  let last: { who: string; ts: string; txt: string } | null = null;
  for (const block of String(vtt).replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n"), ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const ts = lines[ti].split("-->")[0].trim().replace(/\.\d+$/, "");
    const raw = lines.slice(ti + 1).join(" ");
    const who = (raw.match(/<v\s+([^>]+)>/)?.[1] || "").trim();
    const txt = raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!txt) continue;
    if (last && last.who === who) last.txt += " " + txt;
    else { last = { who, ts, txt }; out.push(last); }
  }
  const fmt = (ts: string) => { const [h, m, s] = ts.split(":"); return h === "00" ? `${m}:${s}` : `${Number(h)}:${m}:${s}`; };
  return { text: out.map((x) => `[${fmt(x.ts)}] ${x.who || "?"}: ${x.txt}`).join("\n\n"), speakers: [...new Set(out.map((x) => x.who).filter(Boolean))] };
}
async function syncTranscripts(members: any[], links: any[]) {
  const res = { saved: 0, waiting: 0, none: 0, error: null as string | null };
  // Procura a partir de 5 min depois do início (a chamada pode acabar antes da hora marcada) e repete até haver transcrição
  const now = Date.now(), since = new Date(now - TRANSCRIPT_DAYS * 864e5).toISOString(), nowIso = new Date(now).toISOString();
  const startedIso = new Date(now - 5 * 6e4).toISOString();
  const byEmail = Object.fromEntries(members.map((m) => [String(m.email).toLowerCase(), m]));
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  const cand = new Map<string, any>();
  // Reuniões Teams lidas dos calendários, organizadas por alguém da equipa
  const ev = await db.from("ms_events").select("ical_uid, subject, start_at, end_at, join_url, organizer_email, organizer")
    .eq("is_online", true).not("join_url", "is", null).gte("end_at", since).lte("start_at", startedIso);
  for (const e of ev.data || []) {
    const org = byEmail[e.organizer_email || ""];
    if (org && e.ical_uid && !cand.has(e.ical_uid)) cand.set(e.ical_uid, { ...e, org, project_id: null, milestone_id: null });
  }
  // Marcos da app com reunião online (o evento foi criado pela app no calendário do organizador)
  const ml = links.filter((l: any) => l.source_key?.startsWith("m:") && l.join_url && l.ical_uid);
  if (ml.length) {
    const mr = await db.from("project_milestones").select("id, project_id, category_id, title, event_date, start_time, end_time, all_day")
      .in("id", ml.map((l: any) => l.source_key.slice(2)));
    const mBy = Object.fromEntries((mr.data || []).map((m: any) => [m.id, m]));
    for (const l of ml) {
      const m = mBy[l.source_key.slice(2)];
      if (!m || m.all_day || !m.start_time || !byId[l.member_id]) continue;
      const st = lisbonToUtc(m.event_date, String(m.start_time));
      const en = m.end_time ? lisbonToUtc(m.event_date, String(m.end_time)) : new Date(st.getTime() + 36e5);
      if (en.toISOString() < since || st.toISOString() > startedIso) continue;
      cand.set(l.ical_uid, { ical_uid: l.ical_uid, subject: m.title, start_at: st.toISOString(), end_at: en.toISOString(), join_url: l.join_url,
        org: byId[l.member_id], organizer: byId[l.member_id].name, project_id: m.project_id, category_id: m.category_id, milestone_id: m.id });
    }
  }
  if (!cand.size) return res;
  const seen = await db.from("meeting_transcripts").select("ical_uid, status, attempts").in("ical_uid", [...cand.keys()]);
  const prev = Object.fromEntries((seen.data || []).map((x: any) => [x.ical_uid, x]));
  const pr = await db.from("projects").select("id, name, code").is("archived_at", null);
  const norm = (x: string) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const guessProject = (subject: string) => {
    const s = norm(subject);
    return (pr.data || []).find((p: any) => (p.code && s.includes(norm(p.code))) || (p.name && norm(p.name).length >= 4 && s.includes(norm(p.name))))?.id || null;
  };
  for (const c of cand.values()) {
    const p = prev[c.ical_uid];
    if (p && (p.status === "done" || p.status === "none")) continue;
    const row: any = { ical_uid: c.ical_uid, subject: c.subject, start_at: c.start_at, end_at: c.end_at, organizer_id: c.org.id,
      attempts: (p?.attempts || 0) + 1, checked_at: nowIso, error: null };
    const late = now - new Date(c.end_at).getTime() > TRANSCRIPT_WAIT_H * 36e5;
    try {
      const uid = await userId(c.org.email);
      const f = encodeURIComponent(`JoinWebUrl eq '${c.join_url}'`);
      const om = (await g("GET", `/users/${uid}/onlineMeetings?$filter=${f}`))?.value?.[0];
      const tr = om ? ((await g("GET", `/users/${uid}/onlineMeetings/${om.id}/transcripts`))?.value || []) : [];
      if (!tr.length) {
        row.status = late ? "none" : "waiting";
        late ? res.none++ : res.waiting++;
      } else {
        const parts = [], speakers = new Set<string>();
        for (const t of [...tr].sort((a: any, b: any) => String(a.createdDateTime).localeCompare(String(b.createdDateTime)))) {
          const vtt = await g("GET", `/users/${uid}/onlineMeetings/${om.id}/transcripts/${t.id}/content?$format=text/vtt`);
          const x = vttToText(typeof vtt === "string" ? vtt : "");
          if (x.text) parts.push(x.text);
          x.speakers.forEach((s) => speakers.add(s));
        }
        const head = [
          "Transcrição automática da reunião Teams (sem edição).",
          `${lisbon(c.start_at, { day: "numeric", month: "long", year: "numeric" })}, ${lisbon(c.start_at, { hour: "2-digit", minute: "2-digit" })}–${lisbon(c.end_at, { hour: "2-digit", minute: "2-digit" })} · organizada por ${c.organizer || c.org.name}`,
          speakers.size ? "Participantes que falaram: " + [...speakers].join(", ") : "",
        ].filter(Boolean).join("\n");
        const ins = await db.from("meeting_notes").insert({
          title: `Transcrição — ${c.subject || "Reunião Teams"}`, body: head + "\n\n" + (parts.join("\n\n— nova sessão —\n\n") || "(transcrição vazia)"),
          meeting_date: new Date(c.start_at).toLocaleDateString("sv-SE", { timeZone: TZ }),
          // a ata fica no projeto do marco, ou na categoria do marco; reuniões do Outlook: projeto pelo assunto
          ...(() => { const pid = c.project_id || (c.category_id ? null : guessProject(c.subject)); return { project_id: pid, category_id: pid ? null : (c.category_id || null) }; })(),
          milestone_id: c.milestone_id, created_by: c.org.id,
        }).select("id").single();
        if (ins.error) throw ins.error;
        row.status = "done"; row.note_id = ins.data.id; res.saved++;
      }
    } catch (e: any) {
      row.status = late ? "none" : "error"; row.error = e.message;
      if (e.status === 403 || e.status === 401) {
        res.error = "Sem permissão para ler reuniões/transcrições: faltam as permissões no Entra ou a política do Teams (Definições → Office 365).";
        await db.from("meeting_transcripts").upsert({ ...row, status: "error" });
        break;
      }
      res.error = e.message;
    }
    await db.from("meeting_transcripts").upsert(row);
  }
  return res;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!TENANT || !CLIENT || !SECRET) { await saveStatus({ configured: false }); return json({ configured: false }); }
  const lk = await db.from("app_settings").select("value").eq("key", LOCK_KEY).maybeSingle();
  const lockedAt = Date.parse(lk.data?.value?.at || "");
  if (lockedAt && Date.now() - lockedAt < LOCK_MS) return json({ configured: true, busy: true });
  await db.from("app_settings").upsert({ key: LOCK_KEY, value: { at: new Date().toISOString() }, updated_at: new Date().toISOString() });
  try {
    await getToken();
    const mr = await db.from("team_members").select("id, name, email, active").eq("active", true);
    if (mr.error) throw mr.error;
    const members = (mr.data || []).filter((m: any) => /@/.test(m.email || ""));
    const [wants, lr] = await Promise.all([desired(members), db.from("ms_event_links").select("*")]);
    const links = lr.data || [];
    // Marcos que ainda existem mas já foram realizados ou ficaram para trás: o evento fica no calendário
    const keep = new Set<string>();
    const wanted = new Set(wants.map((w) => w.key));
    const gone = [...new Set(links.filter((l: any) => l.source_key.startsWith("m:") && !wanted.has(l.source_key)).map((l: any) => l.source_key.slice(2)))];
    if (gone.length) {
      const r = await db.from("project_milestones").select("id, done, event_date").in("id", gone);
      if (r.error) throw r.error;
      const from = addDays(todayKey(), -WRITE_BACK);
      (r.data || []).forEach((x: any) => { if (x.done || x.event_date < from) keep.add("m:" + x.id); });
    }
    // Ausências já passadas ficam no calendário (só sai do Outlook a que foi apagada na app)
    const goneAbs = [...new Set(links.filter((l: any) => l.source_key.startsWith("a:") && !wanted.has(l.source_key)).map((l: any) => l.source_key.slice(2)))];
    if (goneAbs.length) {
      const r = await db.from("absences").select("id").in("id", goneAbs);
      if (r.error) throw r.error;
      (r.data || []).forEach((x: any) => keep.add("a:" + x.id));
    }
    const out = [];
    for (const m of members) {
      try { out.push(await syncMember(m, wants, links, keep)); }
      catch (e: any) { out.push({ name: m.name, error: e.message }); }
    }
    const ok = out.every((x: any) => !x.error);
    let transcripts: any = null, autorecord: any = null, daybreak: any = null;
    try { daybreak = await ensureDaybreak(members); } catch (e: any) { daybreak = { error: e.message }; }
    try { autorecord = await syncAutoRecord(members, links); } catch (e: any) { autorecord = { error: e.message }; }
    try { transcripts = await syncTranscripts(members, links); } catch (e: any) { transcripts = { error: e.message }; }
    await saveStatus({ configured: true, ok, members: out, transcripts, autorecord, daybreak });
    return json({ configured: true, ok, members: out, transcripts, autorecord, daybreak });
  } catch (e: any) {
    await saveStatus({ configured: true, ok: false, error: e.message });
    return json({ configured: true, ok: false, error: e.message }, 200);
  } finally {
    await db.from("app_settings").upsert({ key: LOCK_KEY, value: { at: null }, updated_at: new Date().toISOString() });
  }
});
