// NOVA Compass — vigilância da legislação urbanística (registo de regimes legais em legal_regimes)
// run       — mensal (pg_cron, dia 1) ou «Verificar agora» na app: pergunta ao Gemini se houve alterações a cada regime vigiado
//             e classifica: sem_alteracao · alerta (sinal sem fonte primária) · confirmada (há link do Diário da República
//             que a função abriu e onde encontrou o diploma). Só a fonte primária conta como alteração.
//             Confirmada → atualiza o registo (nova versão em legal_regime_versions), marca os relatórios afetados como
//             desatualizados (os entregues não mudam de conteúdo nem de estado), cria rascunhos de reanálise e avisa os sócios.
//             Tudo fica em legal_watch_log; uma falha também fica registada e é avisada.
// simulate  — sócios: simula uma alteração confirmada (teste do circuito), marcada como simulação
// revert    — sócios: desfaz uma simulação (registo, relatórios e rascunhos voltam ao que eram)
// Avisos por email: Office 365 (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET). Com Mail.Send envia; só com Mail.ReadWrite
// deixa a mensagem na caixa de entrada de cada sócio; sem nenhuma, fica só o aviso na app.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KEY = (["GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_AI_API_KEY"].map((n) => Deno.env.get(n)).find((v) => v && v.trim()) ?? "").trim();
const MODELS = [...new Set([Deno.env.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-3.5-flash-lite"].filter(Boolean) as string[])];
const API = "https://generativelanguage.googleapis.com";
const TENANT = Deno.env.get("MS_TENANT_ID") ?? "", CLIENT = Deno.env.get("MS_CLIENT_ID") ?? "", SECRET = Deno.env.get("MS_CLIENT_SECRET") ?? "";
const APP_URL = "https://rodrinova.github.io/nova-compass/";
const db = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const cut = (s: unknown, n: number) => String(s ?? "").slice(0, n);
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
const PRIMARY = /(^|\.)(diariodarepublica\.pt|dre\.pt)$/i;
const STATUSES = ["em_vigor", "revogado_parcial", "revogado", "publicado_sem_vigencia", "em_preparacao", "a_validar"];

// ---------- Gemini (com pesquisa Google quando o plano deixa; senão sem) ----------
let noThinkingCap = false;
async function gemini(body: Record<string, unknown>): Promise<any> {
  let last: any = null, limited = false;
  for (const withSearch of [true, false]) {
    for (const m of MODELS) {
      const gc = { ...(body as any).generationConfig, ...(noThinkingCap ? {} : { thinkingConfig: { thinkingBudget: 512 } }) };
      const b = withSearch ? { ...body, generationConfig: gc, tools: [{ google_search: {} }] } : { ...body, generationConfig: { ...gc, responseMimeType: "application/json" } };
      // modelo que não responda em 60 s: passa ao seguinte
      let r: Response;
      try { r = await fetch(`${API}/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY }, body: JSON.stringify(b), signal: AbortSignal.timeout(60000) }); }
      catch { last = { status: 504, body: { error: { message: `O modelo ${m} não respondeu a tempo` } }, model: m }; continue; }
      last = { status: r.status, body: await r.json().catch(() => ({})), model: m };
      // modelo que não aceite o limite de raciocínio: daqui em diante vai sem ele
      if (r.status === 400 && !noThinkingCap && /thinking/i.test(last.body?.error?.message || "")) { noThinkingCap = true; return gemini(body); }
      const um = last.body?.usageMetadata || {};
      if (r.status === 200) {
        await db.from("ai_usage").insert({ model: m, feature: "legal_watch", status: "ok", prompt_tokens: um.promptTokenCount ?? null, output_tokens: um.candidatesTokenCount ?? null, total_tokens: um.totalTokenCount ?? null });
        const cand = last.body?.candidates?.[0] || {};
        return { text: (cand.content?.parts || []).map((p: any) => p.text || "").join(""), searched: withSearch, model: m, chunks: (cand.groundingMetadata?.groundingChunks || []).map((c: any) => c.web?.uri).filter(Boolean) };
      }
      if (r.status === 429 && /PerDay|PerMinute/.test(JSON.stringify(last.body))) {
        // o limite é por modelo: tenta o seguinte; só falha se todos estiverem esgotados
        await db.from("ai_usage").insert({ model: m, feature: "legal_watch", status: "limit", detail: { message: cut(last.body?.error?.message, 300) } });
        limited = true;
      }
    }
  }
  if (limited && last?.status === 429) throw new Error("Limite diário do Gemini atingido em todos os modelos");
  throw new Error(`Gemini: ${cut(last?.body?.error?.message || last?.status, 300)}`);
}
const parseJson = (t: string) => { const m = t.match(/\{[\s\S]*\}/); if (!m) throw new Error("A IA não devolveu JSON"); return JSON.parse(m[0]); };

// Fonte primária: o link tem de ser do Diário da República, abrir, e o texto tem de mencionar o diploma
async function primaryOk(url: string, ref: string) {
  try {
    const u = new URL(url);
    if (!PRIMARY.test(u.hostname)) return false;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Mozilla/5.0 (NOVA Compass; vigilância legal)" } });
    if (!r.ok) return false;
    const text = cut(await r.text(), 1500000).replace(/\s+/g, " ");
    const nums = String(ref || "").match(/\d+(?:-[A-Z])?\/\d{4}/g) || [];
    return nums.length ? nums.some((n) => text.includes(n)) : true;
  } catch { return false; }
}

// ---------- avisos por email aos sócios (Office 365) ----------
let msToken = "", msRoles: string[] = [];
async function msLogin() {
  if (!TENANT || !CLIENT || !SECRET) return false;
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }) });
  const j = await r.json(); if (!r.ok) return false;
  msToken = j.access_token;
  try { msRoles = JSON.parse(atob(msToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).roles || []; } catch { msRoles = []; }
  return true;
}
async function notifyPartners(subject: string, html: string) {
  const { data: tm } = await db.from("team_members").select("name, email, role, active");
  const partners = (tm || []).filter((m: any) => m.active !== false && /partner|s[oó]cio/i.test(m.role || "") && m.email);
  if (!partners.length) return { ok: false, how: "sem sócios com email" };
  if (!(await msLogin())) return { ok: false, how: "Office 365 não ligado" };
  const send = msRoles.includes("Mail.Send"), drop = msRoles.includes("Mail.ReadWrite");
  if (!send && !drop) return { ok: false, how: "falta a permissão Mail.Send no Office 365" };
  let n = 0;
  for (const p of partners) {
    const msg = { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: p.email, name: p.name } }] };
    const url = send ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(p.email)}/sendMail` : `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(p.email)}/mailFolders/inbox/messages`;
    // sem Mail.Send: a mensagem fica na caixa de entrada como recebida (não como rascunho)
    const body = send ? { message: msg, saveToSentItems: false } : { ...msg, from: { emailAddress: { address: p.email, name: "NOVA Compass" } }, singleValueExtendedProperties: [{ id: "Integer 0x0E07", value: "0" }] };
    const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + msToken, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok || r.status === 202) n++;
  }
  return { ok: n > 0, how: send ? `enviado a ${n}` : `na caixa de entrada de ${n}` };
}

// ---------- aplicar uma alteração confirmada ----------
async function applyChange(reg: any, proposed: any, info: { runId: string; summary: string; source: string | null; sim: boolean; by?: any }) {
  const patch: any = { version: (reg.version || 1) + 1, updated_at: new Date().toISOString() };
  for (const k of ["status", "published_on", "in_force_on", "revoked_on", "articles_affected", "transitional", "dre_ref", "source_url"]) if (proposed?.[k] != null && proposed[k] !== "") patch[k] = proposed[k];
  if (patch.status && !STATUSES.includes(patch.status)) delete patch.status;
  if (info.source && !patch.source_url) patch.source_url = info.source;
  await db.from("legal_regimes").update(patch).eq("id", reg.id);
  await db.from("legal_regime_versions").insert({ regime_id: reg.id, version: patch.version, data: { ...reg, ...patch }, reason: (info.sim ? "SIMULAÇÃO · " : "") + info.summary, source_url: info.source, changed_by: info.by?.id || null, changed_by_name: info.by?.name || (info.sim ? null : "Vigilância automática") });
  // relatórios feitos com este regime
  const { data: reps } = await db.from("framing_reports").select("id, plot_id, version, status, outdated_at, outdated_reason, regime_snapshot, sections, params, typology, input, capacity, risk, sources, pdm_doc_id, model, kind, simulation")
    .is("outdated_at", null).neq("status", "desatualizado");
  const hit = (reps || []).filter((r: any) => (r.regime_snapshot || []).some((x: any) => x.id === reg.id));
  const reason = `${reg.short || reg.name}: ${cut(info.summary, 200)}`, now = new Date().toISOString();
  const before = hit.map((r: any) => ({ id: r.id, status: r.status, outdated_at: r.outdated_at, outdated_reason: r.outdated_reason }));
  for (const r of hit) await db.from("framing_reports").update({ outdated_at: now, outdated_reason: reason, ...(r.status === "entregue" ? {} : { status: "desatualizado" }) }).eq("id", r.id);
  // um rascunho de reanálise por oportunidade (a partir do relatório mais recente afetado); a equipa volta a correr a IA
  const latest = new Map<string, any>();
  for (const r of hit) if (!latest.has(r.plot_id) || latest.get(r.plot_id).version < r.version) latest.set(r.plot_id, r);
  const drafts: string[] = [];
  for (const r of latest.values()) {
    const { data: top } = await db.from("framing_reports").select("version").eq("plot_id", r.plot_id).order("version", { ascending: false }).limit(1);
    const sections = { ...(r.sections || {}), to_validate: [`Reanalisar: a legislação mudou (${reason}).`, ...((r.sections || {}).to_validate || [])] };
    const { data: d } = await db.from("framing_reports").insert({ plot_id: r.plot_id, version: (top?.[0]?.version || r.version) + 1, kind: "reanalise", status: "rascunho", typology: r.typology, input: r.input, params: r.params, sections, capacity: r.capacity, risk: r.risk,
      sources: r.sources, regime_snapshot: r.regime_snapshot, pdm_doc_id: r.pdm_doc_id, model: r.model, supersedes: r.id, simulation: info.sim, created_by_name: info.sim ? "Simulação" : "Vigilância automática",
      diff: { reason, regime: reg.id, from_version: reg.version, to_version: patch.version, original: r.sections } }).select("id").single();
    if (d) drafts.push(d.id);
  }
  return { before, drafts, prev: reg, version: patch.version, affected: hit.length };
}

// ---------- vigilância ----------
async function run(trigger: string) {
  const runId = crypto.randomUUID();
  const { data: regs, error } = await db.from("legal_regimes").select("*").eq("watch", true).order("sort");
  if (error) throw error;
  const today = new Date().toISOString().slice(0, 10);
  const prompt = (list: any[]) => `Hoje é ${today}. És um jurista português especialista em direito do urbanismo e da construção. Para cada regime abaixo, diz se houve, depois do que está registado, alguma publicação no Diário da República que o altere: nova lei ou decreto-lei, alteração, republicação, revogação, entrada em vigor, adiamento ou regime transitório.
Regra: só indiques "publicado" se souberes o número do diploma e a data de publicação; dá o link do Diário da República (diariodarepublica.pt) se o souberes. Se só ouviste falar (anúncio do Governo, proposta, notícia), usa "possivel". Se não sabes de nada, usa "nenhuma". Não inventes números nem links.
Responde só com JSON: {"items":[{"id":"…","change":"nenhuma|possivel|publicado","summary":"…","diploma":"ex.: Decreto-Lei n.º 10/2024","date":"AAAA-MM-DD ou vazio","dr_url":"…","proposed":{"status":"em_vigor|revogado_parcial|revogado|publicado_sem_vigencia|em_preparacao|a_validar","published_on":"","in_force_on":"","revoked_on":"","articles_affected":"","transitional":""}}]}
REGISTO ATUAL:
${JSON.stringify(list.map((r: any) => ({ id: r.id, nome: r.name, diploma: r.diploma, estado: r.status, publicado: r.published_on, em_vigor_desde: r.in_force_on, revogado: r.revoked_on, transitorio: r.transitional, ref_dr: r.dre_ref })), null, 1)}`;
  const out = { runId, trigger, checked: 0, sem_alteracao: 0, alerta: 0, confirmada: 0, notified: null as any };
  // dois pedidos em paralelo (metade dos regimes cada): um só passa do tempo que o Supabase dá a cada função
  const half = Math.ceil((regs || []).length / 2), parts = [(regs || []).slice(0, half), (regs || []).slice(half)].filter((x) => x.length);
  const gs = await Promise.all(parts.map((list) => gemini({ contents: [{ role: "user", parts: [{ text: prompt(list) }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 4096 } })));
  const g = { searched: gs.some((x) => x.searched) };
  const items = gs.flatMap((x) => parseJson(x.text).items || []);
  const findings: string[] = [];
  for (const reg of regs || []) {
    const it = items.find((x: any) => x.id === reg.id) || { change: "nenhuma" };
    out.checked++;
    let kind = "sem_alteracao", primary = false, url: string | null = it.dr_url || null;
    if (it.change === "publicado" || it.change === "possivel") {
      primary = !!url && await primaryOk(url, it.diploma);
      kind = it.change === "publicado" && primary ? "confirmada" : "alerta";
    }
    const summary = kind === "sem_alteracao" ? "Sem alterações encontradas" : cut([it.diploma, it.date, it.summary].filter(Boolean).join(" · "), 500);
    const { data: log } = await db.from("legal_watch_log").insert({ run_id: runId, regime_id: reg.id, kind, finding: summary, source_url: url, source_primary: primary, proposed: kind === "sem_alteracao" ? null : { ...it.proposed, diploma: it.diploma, date: it.date, searched: g.searched } }).select("id").single();
    await db.from("legal_regimes").update({ checked_at: new Date().toISOString(), check_summary: summary }).eq("id", reg.id);
    (out as any)[kind]++;
    if (kind === "confirmada") {
      const res = await applyChange(reg, it.proposed, { runId, summary, source: url, sim: false });
      await db.from("legal_watch_log").update({ decision: "aplicada", decided_at: new Date().toISOString(), decided_by_name: "Vigilância automática", proposed: { ...it.proposed, diploma: it.diploma, applied: res } }).eq("id", log?.id);
      findings.push(`<li><b>${esc(reg.short || reg.name)}</b> — alteração confirmada no Diário da República: ${esc(summary)}. ${res.affected} ${res.affected === 1 ? "relatório desatualizado" : "relatórios desatualizados"}; ${res.drafts.length} ${res.drafts.length === 1 ? "rascunho" : "rascunhos"} de reanálise.</li>`);
    } else if (kind === "alerta") findings.push(`<li><b>${esc(reg.short || reg.name)}</b> — sinal por confirmar (sem fonte primária): ${esc(summary)}</li>`);
  }
  if (findings.length) {
    out.notified = await notifyPartners(`NOVA Compass · legislação: ${out.confirmada ? `${out.confirmada} alteração(ões) confirmada(s)` : `${out.alerta} alerta(s)`}`,
      `<p>Olá,</p><p>A verificação ${trigger === "cron" ? "mensal" : "pedida na app"} da legislação urbanística encontrou:</p><ul>${findings.join("")}</ul><p>Revê em <a href="${APP_URL}">NOVA Compass → Definições → Regime legal</a>.</p>`);
    await db.from("legal_watch_log").update({ notified: !!out.notified?.ok }).eq("run_id", runId).neq("kind", "sem_alteracao");
  }
  return out;
}

async function caller(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const u = await db.auth.getUser(jwt).catch(() => null);
  const email = String(u?.data?.user?.email || "").toLowerCase();
  if (!email) return null;
  const { data } = await db.from("team_members").select("id, name, email, role").ilike("email", email).maybeSingle();
  return data || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  try {
    if (!b.action || b.action === "run") {
      const me = b.trigger === "manual" ? await caller(req) : null;
      if (b.trigger === "manual" && !me) return json({ error: "Só para a equipa" }, 403);
      if (!KEY) throw new Error("Falta a chave do Gemini");
      // corre em segundo plano: a resposta sai já, o resultado fica no registo (legal_watch_log)
      const job = run(b.trigger === "manual" ? "manual" : "cron").catch(async (e) => {
        const msg = cut((e as Error).message, 500);
        await db.from("legal_watch_log").insert({ run_id: crypto.randomUUID(), kind: "erro", finding: "A verificação da legislação falhou", error: msg });
        await notifyPartners("NOVA Compass · a verificação da legislação falhou", `<p>A verificação da legislação urbanística não correu: ${esc(msg)}</p><p>Vê em NOVA Compass → Definições → Regime legal.</p>`).catch(() => null);
      });
      if (typeof EdgeRuntime !== "undefined") { EdgeRuntime.waitUntil(job); return json({ started: true }); }
      await job; return json({ started: true });
    }
    const me = await caller(req);
    if (!me || !/partner|s[oó]cio/i.test(me.role || "")) return json({ error: "Só os sócios podem simular ou reverter" }, 403);
    if (b.action === "simulate") {
      const { data: reg } = await db.from("legal_regimes").select("*").eq("id", b.regime_id).single();
      if (!reg) return json({ error: "Regime não encontrado" }, 404);
      const runId = crypto.randomUUID(), today = new Date().toISOString().slice(0, 10);
      const proposed = b.proposed || { status: "em_vigor", in_force_on: today };
      const summary = cut(b.summary || `Simulação: ${reg.short || reg.name} passa a ${proposed.status === "em_vigor" ? "estar em vigor" : proposed.status} a ${today}`, 300);
      const res = await applyChange(reg, proposed, { runId, summary, source: null, sim: true, by: me });
      const { data: log } = await db.from("legal_watch_log").insert({ run_id: runId, regime_id: reg.id, kind: "simulacao", finding: summary, source_primary: false, proposed: { ...proposed, applied: res }, decided_by: me.id, decided_by_name: me.name, decided_at: new Date().toISOString() }).select("id").single();
      return json({ ok: true, log: log?.id, affected: res.affected, drafts: res.drafts.length });
    }
    if (b.action === "revert") {
      const { data: log } = await db.from("legal_watch_log").select("*").eq("id", b.log_id).single();
      if (!log || log.kind !== "simulacao") return json({ error: "Só se revertem simulações" }, 400);
      if (log.decision === "revertida") return json({ ok: true, already: true });
      const a = log.proposed?.applied || {};
      const prev = a.prev || {};
      await db.from("legal_regimes").update({ status: prev.status, published_on: prev.published_on, in_force_on: prev.in_force_on, revoked_on: prev.revoked_on, articles_affected: prev.articles_affected, transitional: prev.transitional, dre_ref: prev.dre_ref, source_url: prev.source_url, version: prev.version, updated_at: new Date().toISOString() }).eq("id", log.regime_id);
      await db.from("legal_regime_versions").delete().eq("regime_id", log.regime_id).eq("version", a.version).like("reason", "SIMULAÇÃO%");
      for (const r of a.before || []) await db.from("framing_reports").update({ status: r.status, outdated_at: r.outdated_at, outdated_reason: r.outdated_reason }).eq("id", r.id);
      if ((a.drafts || []).length) await db.from("framing_reports").delete().in("id", a.drafts).eq("simulation", true);
      await db.from("legal_watch_log").update({ decision: "revertida", decided_by: me.id, decided_by_name: me.name, decided_at: new Date().toISOString() }).eq("id", log.id);
      return json({ ok: true });
    }
    return json({ error: "Ação desconhecida" }, 400);
  } catch (e) {
    // a falha fica registada e os sócios são avisados
    const msg = cut((e as Error).message, 500);
    await db.from("legal_watch_log").insert({ run_id: crypto.randomUUID(), kind: "erro", finding: "A verificação da legislação falhou", error: msg }).then(() => {}, () => {});
    if (!b.action || b.action === "run") await notifyPartners("NOVA Compass · a verificação da legislação falhou", `<p>A verificação da legislação urbanística não correu: ${esc(msg)}</p><p>Vê em NOVA Compass → Definições → Regime legal.</p>`).catch(() => null);
    return json({ error: msg }, 500);
  }
});
