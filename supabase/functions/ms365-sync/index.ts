// NOVA Compass — sincronização com o Office 365 (calendários Outlook/Teams)
// Corre de 10 em 10 minutos (pg_cron, ver office365.sql) e com "Sincronizar agora" (Definições → Office 365).
// Para cada pessoa ativa da equipa (pelo email @novassociates.com):
//   1. ESCREVE no calendário principal dela (o que o Teams e o iPhone mostram), com a categoria "NOVA Compass":
//      - marcos e entregas de que é responsável (não as fases de projeto, nem prazos a controlar);
//      - reuniões marcadas na app: uma reunião Teams, organizada pelo 1.º responsável, com os outros convidados;
//      - lembretes do Investment Intelligence: apresentação sem resposta ao fim de 7 dias (para o responsável da oportunidade).
//      A app é a fonte: o que muda na app atualiza o evento; o que sai da app é apagado do calendário.
//   2. LÊ o calendário dela (reuniões Teams e eventos do Outlook) para a Agenda e a Hoje da app.
//      Eventos privados ficam só como "Ocupado".
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
    if (r.status === 204) return null;
    const t = await r.text();
    const j = t ? JSON.parse(t) : null;
    if (!r.ok) { const e: any = new Error(j?.error?.message || `Graph ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  throw new Error("Office 365 ocupado — volta a tentar daqui a pouco");
}

// ---------- O que a app quer em cada calendário ----------
type Want = { key: string; member: string; payload: Record<string, unknown> };
async function desired(members: any[]) {
  const from = addDays(todayKey(), -WRITE_BACK), to = addDays(todayKey(), WRITE_AHEAD);
  const [ms, ow, ty, pr, pres, plots, invs] = await Promise.all([
    db.from("project_milestones").select("id, project_id, type_id, title, event_date, all_day, start_time, end_time, location, notes, done, auto_kind").gte("event_date", from).lte("event_date", to),
    db.from("milestone_owners").select("milestone_id, member_id"),
    db.from("milestone_types").select("id, name, is_deadline"),
    db.from("projects").select("id, name, code"),
    db.from("land_presentations").select("id, plot_id, investor_id, contact_name, presented_on, status"),
    db.from("land_plots").select("id, name, scout_id, status"),
    db.from("investors").select("id, name"),
  ]);
  for (const r of [ms, ow, ty, pr]) if (r.error) throw r.error;
  const types = Object.fromEntries((ty.data || []).map((t: any) => [t.id, t]));
  const projs = Object.fromEntries((pr.data || []).map((p: any) => [p.id, p]));
  const byM: Record<string, string[]> = {};
  (ow.data || []).forEach((o: any) => (byM[o.milestone_id] = byM[o.milestone_id] || []).push(o.member_id));
  const email = Object.fromEntries(members.map((m) => [m.id, m]));
  const out: Want[] = [];
  const body = (lines: string[]) => ({ contentType: "HTML", content: lines.filter(Boolean).map((l) => `<p>${l}</p>`).join("") + `<p><a href="${APP_URL}">Abrir no NOVA Compass</a></p>` });
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
    const base = {
      subject, body: body([esc(t?.name || (m.auto_kind === "delivery" ? "Entrega" : "Marco")), m.notes ? esc(m.notes) : ""]),
      start: { dateTime: start, timeZone: TZ }, end: { dateTime: end, timeZone: TZ }, isAllDay: !timed,
      location: m.location ? { displayName: m.location } : undefined, categories: [CATEGORY],
      showAs: timed ? "busy" : "free", isReminderOn: timed,
    };
    const meeting = timed && !m.auto_kind && /reuni/i.test(t?.name || "");
    if (meeting) {
      // uma só reunião Teams: organizada pelo 1.º responsável, os outros recebem o convite
      const [org, ...rest] = owners;
      out.push({ key: `m:${m.id}`, member: org, payload: { ...base, isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness",
        attendees: rest.map((id) => ({ emailAddress: { address: email[id].email, name: email[id].name }, type: "required" })) } });
    } else owners.forEach((id) => out.push({ key: `m:${m.id}`, member: id, payload: base }));
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
  return out;
}

async function ensureCategory(upn: string) {
  try {
    const r = await g("GET", `/users/${encodeURIComponent(upn)}/outlook/masterCategories`);
    if (!(r?.value || []).some((c: any) => c.displayName === CATEGORY))
      await g("POST", `/users/${encodeURIComponent(upn)}/outlook/masterCategories`, { displayName: CATEGORY, color: "preset8" });
  } catch (_) { /* sem MailboxSettings: os eventos ficam sem cor própria, mas sincronizam */ }
}

// ---------- Uma pessoa ----------
async function syncMember(m: any, wants: Want[], links: any[]) {
  const upn = encodeURIComponent(m.email);
  const res = { name: m.name, written: 0, deleted: 0, read: 0, error: null as string | null };
  await ensureCategory(m.email);
  // 1. Escrever
  const mine = wants.filter((w) => w.member === m.id);
  const myLinks = links.filter((l) => l.member_id === m.id);
  for (const w of mine) {
    const hash = await sha(JSON.stringify(w.payload));
    const l = myLinks.find((x) => x.source_key === w.key);
    try {
      if (l && l.hash === hash) continue;
      if (l) {
        try { await g("PATCH", `/users/${upn}/events/${l.ms_event_id}`, w.payload); }
        catch (e: any) { if (e.status !== 404) throw e; const c = await g("POST", `/users/${upn}/events`, w.payload); l.ms_event_id = c.id; l.ical_uid = c.iCalUId; }
        await db.from("ms_event_links").update({ hash, ms_event_id: l.ms_event_id, ical_uid: l.ical_uid, updated_at: new Date().toISOString() }).eq("member_id", m.id).eq("source_key", w.key);
      } else {
        const c = await g("POST", `/users/${upn}/events`, w.payload);
        await db.from("ms_event_links").upsert({ member_id: m.id, source_key: w.key, ms_event_id: c.id, ical_uid: c.iCalUId, hash, updated_at: new Date().toISOString() });
        links.push({ member_id: m.id, source_key: w.key, ms_event_id: c.id, ical_uid: c.iCalUId, hash });
      }
      res.written++;
    } catch (e: any) { res.error = e.message; }
  }
  for (const l of myLinks.filter((x) => !mine.some((w) => w.key === x.source_key))) {
    try { await g("DELETE", `/users/${upn}/events/${l.ms_event_id}`); } catch (e: any) { if (e.status !== 404) { res.error = e.message; continue; } }
    await db.from("ms_event_links").delete().eq("member_id", m.id).eq("source_key", l.source_key);
    res.deleted++;
  }
  // 2. Ler
  const start = new Date(addDays(todayKey(), -READ_BACK) + "T00:00:00Z").toISOString();
  const end = new Date(addDays(todayKey(), READ_AHEAD) + "T00:00:00Z").toISOString();
  const ours = new Set(links.map((l) => l.ical_uid).filter(Boolean));
  const rows: any[] = [];
  let url: string | null = `/users/${upn}/calendarView?startDateTime=${start}&endDateTime=${end}&$top=200&$select=id,iCalUId,subject,start,end,isAllDay,location,isOnlineMeeting,onlineMeeting,showAs,sensitivity,organizer,webLink,categories,isCancelled`;
  while (url) {
    const r: any = await g("GET", url, undefined, { Prefer: `outlook.timezone="UTC"` });
    for (const e of r.value || []) {
      if (e.isCancelled || (e.categories || []).includes(CATEGORY) || ours.has(e.iCalUId)) continue;   // o que a app escreveu não volta a entrar
      const priv = e.sensitivity === "private" || e.sensitivity === "confidential";
      rows.push({ member_id: m.id, ms_id: e.id, ical_uid: e.iCalUId, subject: priv ? null : e.subject,
        start_at: e.start.dateTime + "Z", end_at: e.end?.dateTime ? e.end.dateTime + "Z" : null, all_day: !!e.isAllDay,
        location: priv ? null : (e.location?.displayName || null), is_online: !!e.isOnlineMeeting, join_url: priv ? null : (e.onlineMeeting?.joinUrl || null),
        show_as: e.showAs, is_private: priv, organizer: priv ? null : (e.organizer?.emailAddress?.name || null), web_link: e.webLink, synced_at: new Date().toISOString() });
    }
    url = r["@odata.nextLink"] || null;
  }
  await db.from("ms_events").delete().eq("member_id", m.id);
  for (let i = 0; i < rows.length; i += 200) { const r = await db.from("ms_events").insert(rows.slice(i, i + 200)); if (r.error) throw r.error; }
  res.read = rows.length;
  return res;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!TENANT || !CLIENT || !SECRET) { await saveStatus({ configured: false }); return json({ configured: false }); }
  try {
    await getToken();
    const mr = await db.from("team_members").select("id, name, email, active").eq("active", true);
    if (mr.error) throw mr.error;
    const members = (mr.data || []).filter((m: any) => /@/.test(m.email || ""));
    const [wants, lr] = await Promise.all([desired(members), db.from("ms_event_links").select("*")]);
    const links = lr.data || [];
    const out = [];
    for (const m of members) {
      try { out.push(await syncMember(m, wants, links)); }
      catch (e: any) { out.push({ name: m.name, error: e.message }); }
    }
    const ok = out.every((x: any) => !x.error);
    await saveStatus({ configured: true, ok, members: out });
    return json({ configured: true, ok, members: out });
  } catch (e: any) {
    await saveStatus({ configured: true, ok: false, error: e.message });
    return json({ configured: true, ok: false, error: e.message }, 200);
  }
});
