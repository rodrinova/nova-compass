// Enquadramento urbanístico com o Gemini (Google). A equipa revê e aprova sempre.
// Ações:
//   status    — chave ligada, utilização de hoje e limite conhecido (indicador da app)
//   find_pdm  — procura no site da câmara o PDF do Regulamento do PDM em vigor (pesquisa Google), confirma que é um PDF
//               de um site oficial, guarda-o no armazenamento (pdm-docs) e na biblioteca (pdm_library)
//   analyse_start — o mesmo que analyse, em segundo plano (resultado em ai_jobs)
//   analyse   — lê o regulamento (PDF), os dados do formulário, a tipologia e o registo de regimes legais (legal_regimes)
//               e devolve o relatório estruturado: parâmetros com artigo e fonte, grau de certeza, condicionantes,
//               transição RGEU → Código da Construção, lei geral, restrições, riscos e fontes
//   draft     — rascunho simples em 4 parágrafos (versão anterior, mantida para compatibilidade)
// Segredos: GEMINI_API_KEY (também GOOGLE_API_KEY, GEMINI_KEY…); GEMINI_MODEL opcional.
// O estado de vigência da lei vem sempre da tabela legal_regimes: nada de vigência escrito à mão neste ficheiro.
const KEY_NAMES = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_AI_API_KEY"];
const KEY = (KEY_NAMES.map((n) => Deno.env.get(n)).find((v) => v && v.trim()) ?? "").trim();
const MODELS = [...new Set([Deno.env.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash"].filter(Boolean) as string[])];
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "", SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const API = "https://generativelanguage.googleapis.com";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { ...cors, "Content-Type": "application/json" } });
const cut = (s: unknown, n: number) => String(s ?? "").slice(0, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

// ---------- base de dados (service role) ----------
const rest = (path: string, init: RequestInit = {}) => fetch(`${SB_URL}/rest/v1/${path}`, {
  ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", ...(init.headers || {}) },
});
// O armazenamento só aceita a chave nova (sb_secret_…) no cabeçalho apikey; a antiga (JWT) também vai como Bearer
const storageAuth: Record<string, string> = SB_SERVICE.startsWith("eyJ") ? { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` } : { apikey: SB_SERVICE };
const restJson = async (path: string, init: RequestInit = {}) => { const r = await rest(path, init); const t = await r.text(); if (!r.ok) throw new Error(`BD ${r.status}: ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null; };
const userOf = (req: Request) => {
  try { const t = (req.headers.get("Authorization") || "").split(".")[1]; const p = JSON.parse(atob(t.replace(/-/g, "+").replace(/_/g, "/"))); return p.role === "authenticated" ? p.sub : null; } catch { return null; }
};
async function log(row: Record<string, unknown>) { if (SB_URL && SB_SERVICE) await rest("ai_usage", { method: "POST", body: JSON.stringify(row) }).catch(() => {}); }

// ---------- utilização (dia do Google: começa à meia-noite da Califórnia) ----------
function pacificMidnightUtc(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = Math.round((asUtc - now.getTime()) / 60000) * 60000;
  const start = Date.UTC(parts.year, parts.month - 1, parts.day) - offset;
  return { start: new Date(start), next: new Date(start + 864e5) };
}
async function usage() {
  const { start, next } = pacificMidnightUtc();
  const rows: any[] = SB_URL && SB_SERVICE ? await restJson(`ai_usage?select=status,total_tokens,created_at,detail&created_at=gte.${start.toISOString()}&order=created_at.desc`).catch(() => []) : [];
  const ok = rows.filter((r) => r.status === "ok");
  const lastLimit: any[] = SB_URL && SB_SERVICE ? await restJson(`ai_usage?select=detail,created_at&status=eq.limit&order=created_at.desc&limit=1`).catch(() => []) : [];
  const hitToday = rows.find((r) => r.status === "limit");
  return {
    requests: ok.length, tokens: ok.reduce((t, r) => t + (r.total_tokens || 0), 0), resetAt: next.toISOString(),
    limitHit: hitToday ? { at: hitToday.created_at, ...(hitToday.detail || {}) } : null,
    knownLimit: lastLimit[0]?.detail || null,
  };
}
function quotaOf(body: any) {
  const det = body?.error?.details || [];
  const v = det.flatMap((d: any) => d.violations || [])[0] || {};
  const retry = det.find((d: any) => /RetryInfo/.test(d["@type"] || ""))?.retryDelay || null;
  const id = String(v.quotaId || v.quotaMetric || "");
  return { quota: id || null, value: v.quotaValue != null ? Number(v.quotaValue) : null, perDay: /PerDay/i.test(id), perMinute: /PerMinute/i.test(id), retry, message: String(body?.error?.message || "").slice(0, 300) };
}

// ---------- Gemini ----------
// Um pedido com novas tentativas: 503 (sobrecarregado) repete e passa ao modelo seguinte; modelo inexistente ou sem a funcionalidade no plano gratuito passa ao seguinte.
class AiError extends Error { constructor(public code: string, msg: string, public extra: any = null) { super(msg); } }
async function gemini(feature: string, user: string | null, body: Record<string, unknown>) {
  // (body pode perder o thinkingConfig num modelo que não o aceite)
  let last: { status: number; body: any; ms?: number } | null = null, model = MODELS[0], planDenied = false, skipped = false;
  for (const m of MODELS) {
    model = m;
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      const r = await fetch(`${API}/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY }, body: JSON.stringify(body) });
      last = { status: r.status, body: await r.json().catch(() => ({})), ms: Date.now() - t0 };
      // um modelo que não aceite o limite de raciocínio: tenta a outra forma (thinkingBudget) e depois sem limite
      const tc = (body as any).generationConfig?.thinkingConfig;
      if (last.status === 400 && tc && /thinking/i.test(last.body?.error?.message || "")) {
        body = { ...body, generationConfig: { ...(body as any).generationConfig, thinkingConfig: tc.thinkingLevel ? { thinkingBudget: 1024 } : undefined } }; i--; continue;
      }
      if (last.status !== 503) break;
      await sleep(1500);
    }
    // modelo inexistente ou retirado para contas novas: passa ao seguinte
    skipped = last.status === 404 || last.status === 503 || (last.status === 400 && /no longer available|not found|not supported/i.test(last.body?.error?.message || ""));
    if (skipped) continue;
    // 429 sem quota identificada = esta funcionalidade (ex.: pesquisa Google) não está no plano gratuito deste modelo: tenta o seguinte
    if (last.status === 429) {
      const q = quotaOf(last.body);
      if (!q.perDay && !q.perMinute && /billing|plan/i.test(q.message)) { await log({ user_id: user, model: m, feature, status: "error", detail: { status: 429, plan: true, message: q.message } }); planDenied = skipped = true; continue; }
    }
    break;
  }
  if (planDenied && skipped) throw new AiError("plan", "plan");
  if (!last || last.status !== 200) {
    if (last?.status === 429) { const q = quotaOf(last.body); await log({ user_id: user, model, feature, status: "limit", detail: q }); throw new AiError("limit", "limit", q); }
    const msg = last?.body?.error?.message || `Erro ${last?.status}`;
    await log({ user_id: user, model, feature, status: "error", detail: { status: last?.status, message: cut(msg, 300) } });
    throw new AiError(last?.status === 503 ? "busy" : "error", msg);
  }
  const um = last.body?.usageMetadata || {};
  await log({ user_id: user, model, feature, status: "ok", prompt_tokens: um.promptTokenCount ?? null, output_tokens: um.candidatesTokenCount ?? null, total_tokens: um.totalTokenCount ?? null,
    detail: { ms: last.ms, version: last.body?.modelVersion || null, thoughts: um.thoughtsTokenCount ?? null } });
  const cand = last.body?.candidates?.[0] || {};
  return { model, text: (cand.content?.parts || []).map((p: any) => p.text || "").join(""), grounding: cand.groundingMetadata || null };
}
const parseJson = (t: string) => { const m = t.match(/\{[\s\S]*\}/); if (!m) throw new Error("A IA não devolveu JSON"); return JSON.parse(m[0]); };

// ---------- procurar o Regulamento do PDM no site da câmara ----------
const slug = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
// Só sites oficiais: domínios da câmara (cm-*, municipio-*, nome do concelho) ou do Estado (.gov.pt, Diário da República)
// (o domínio tem de conter o nome do concelho ou a sua última palavra: cm-gaia.pt, cm-feira.pt, pdm.cm-porto.pt)
function officialHost(host: string, municipality: string) {
  const h = host.toLowerCase(), hs = slug(h), m = slug(municipality);
  if (/(^|\.)(diariodarepublica\.pt|dre\.pt|gov\.pt)$/.test(h)) return true;
  if (!h.endsWith(".pt")) return false;
  const last = slug(municipality.trim().split(/\s+/).pop() || "");
  return hs.includes(m) || (last.length >= 4 && hs.includes(last));
}
// Pesquisa web sem IA (Bing e DuckDuckGo), para quando o plano gratuito não permite a pesquisa Google do Gemini
async function webSearch(q: string) {
  const get = (u: string) => fetch(u, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", "Accept-Language": "pt-PT,pt;q=0.9" } }).then((r) => r.text()).catch(() => "");
  const [bing, ddg] = await Promise.all([get(`https://www.bing.com/search?setlang=pt-PT&cc=PT&q=${encodeURIComponent(q)}`), get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`)]);
  const fromBing = [...bing.matchAll(/<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  const fromDdg = [...ddg.matchAll(/uddg=([^&"]+)/g)].map((m) => decodeURIComponent(m[1]));
  return [...fromBing, ...fromDdg].filter((u) => /^https?:/.test(u) && !/bing\.com|duckduckgo\.com|microsoft\.com/.test(u)).slice(0, 12);
}
const urlsIn = (t: string) => [...String(t || "").matchAll(/https?:\/\/[^\s"'<>()\]]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ""));
async function resolveRedirect(u: string) {
  if (!/vertexaisearch|grounding-api-redirect/.test(u)) return u;
  try { const r = await fetch(u, { redirect: "manual" }); return r.headers.get("location") || u; } catch { return u; }
}
// Confirma que o endereço é um PDF; se for uma página do site da câmara, procura nela ligações a PDFs do regulamento
async function pdfCandidates(url: string, municipality: string, depth = 0): Promise<string[]> {
  let u: URL; try { u = new URL(url); } catch { return []; }
  if (!officialHost(u.hostname, municipality)) return [];
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Mozilla/5.0 (NOVA Compass; enquadramento PDM)" } });
    const fin = new URL(r.url || url);
    if (!officialHost(fin.hostname, municipality)) return [];
    const ct = r.headers.get("content-type") || "";
    if (/pdf/i.test(ct)) { r.body?.cancel(); return [fin.href]; }
    if (!/html/i.test(ct) || depth > 1) { r.body?.cancel(); return []; }
    const html = cut(await r.text(), 800000);
    const links = [...html.matchAll(/href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)]
      .map((m) => { try { return { href: new URL(m[1].replace(/&amp;/g, "&"), fin.href).href, label: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") }; } catch { return null; } })
      .filter((l): l is { href: string; label: string } => !!l && officialHost(new URL(l.href).hostname, municipality));
    const isReg = (l: { href: string; label: string }) => /regulamento/i.test(l.href + " " + l.label);
    // PDFs do regulamento primeiro; depois (só no primeiro nível) as páginas do site que falam do regulamento ou do PDM
    const pdfs = links.filter((l) => /\.pdf(\?|$)|\/download|file/i.test(l.href) && /regulamento|pdm|plano.diretor/i.test(l.href + " " + l.label)).sort((a, b) => Number(isReg(b)) - Number(isReg(a)));
    const out: string[] = [];
    for (const l of pdfs.slice(0, 6)) { out.push(...await pdfCandidates(l.href, municipality, 2)); if (out.length) return out; }
    if (depth === 0) {
      const pages = links.filter((l) => !/\.pdf(\?|$)/i.test(l.href) && l.href !== fin.href && /regulamento|pdm|plano.diretor|ordenamento|documentos/i.test(l.href + " " + l.label)).sort((a, b) => Number(isReg(b)) - Number(isReg(a)));
      for (const l of [...new Map(pages.map((x) => [x.href, x])).values()].slice(0, 5)) { out.push(...await pdfCandidates(l.href, municipality, 1)); if (out.length) return out; }
    }
    return out;
  } catch { return []; }
}
async function findPdm(user: string | null, municipality: string, typology: string) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Hoje é ${today}. Procura o Regulamento do Plano Diretor Municipal (PDM) em vigor do município de ${municipality} (Portugal), no site oficial da Câmara Municipal ou no Diário da República.
Quero o link DIRETO para o ficheiro PDF do regulamento (de preferência a versão consolidada ou republicada mais recente), o título, a versão (ex.: 1.ª revisão, alteração por adaptação, aviso n.º…) e a data de publicação. Indica também a página do site da câmara onde o PDM está publicado.
Responde só com JSON: {"candidates":[{"url":"…","title":"…","version":"…","date":"AAAA-MM-DD ou vazio","page":"…"}],"notes":"…"}. Se não souberes o link direto do PDF, põe na mesma um candidato com o "url" vazio e a "page" do site oficial onde o PDM está publicado (a aplicação abre essa página e procura lá o PDF). Não inventes links.`;
  // Com pesquisa Google; se o plano não a permitir, pede os links que o modelo conhece (são sempre confirmados ao descarregar)
  let g: any, searched = true;
  try { g = await gemini("find_pdm", user, { contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.1 } }); }
  catch (e) {
    if (!(e instanceof AiError && e.code === "plan")) throw e;
    searched = false;
    g = await gemini("find_pdm", user, { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: "application/json" } });
  }
  let parsed: any = {}; try { parsed = parseJson(g.text); } catch { parsed = { candidates: [] }; }
  const chunks = (g.grounding?.groundingChunks || []).map((c: any) => c.web?.uri).filter(Boolean);
  const web = searched ? [] : [...await webSearch(`regulamento PDM ${municipality} pdf`), ...await webSearch(`"plano diretor municipal" ${municipality} regulamento câmara municipal`)];
  const raw = [...(parsed.candidates || []).flatMap((c: any) => [c.url, c.page]), ...await Promise.all(chunks.map(resolveRedirect)), ...urlsIn(parsed.notes), ...web].filter(Boolean);
  const tried: string[] = [], deadline = Date.now() + 80000;
  for (const url of [...new Set(raw)].slice(0, 16)) {
    if (Date.now() > deadline) break;
    tried.push(url);
    const pdfs = await pdfCandidates(url, municipality);
    if (pdfs.length) {
      const meta = (parsed.candidates || []).find((c: any) => c.url === url || c.page === url) || (parsed.candidates || [])[0] || {};
      return { found: true, searched, url: pdfs[0], page: url !== pdfs[0] ? url : (meta.page || null), title: meta.title || null, version: meta.version || null, date: /^\d{4}-\d{2}-\d{2}$/.test(meta.date || "") ? meta.date : null, notes: parsed.notes || null, tried };
    }
  }
  return { found: false, searched, tried, web: web.length, notes: parsed.notes || null, hint: parsed.candidates?.[0] || null };
}
// Descarrega o PDF encontrado e guarda-o na biblioteca
async function storePdm(user: string | null, municipality: string, f: any) {
  const r = await fetch(f.url, { signal: AbortSignal.timeout(60000), headers: { "User-Agent": "Mozilla/5.0 (NOVA Compass; enquadramento PDM)" } });
  if (!r.ok) throw new Error(`Não foi possível descarregar o PDF (${r.status})`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.byteLength > 50 * 1024 * 1024) throw new Error("O PDF tem mais de 50 MB");
  if (String.fromCharCode(...buf.slice(0, 4)) !== "%PDF") throw new Error("O ficheiro encontrado não é um PDF");
  const path = `${slug(municipality)}/${crypto.randomUUID()}.pdf`;
  const up = await fetch(`${SB_URL}/storage/v1/object/pdm-docs/${path}`, { method: "POST", headers: { ...storageAuth, "Content-Type": "application/pdf" }, body: buf });
  if (!up.ok) throw new Error("Não foi possível guardar o PDF: " + (await up.text()).slice(0, 200));
  const row = await restJson("pdm_library", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({
    municipality, title: f.title || `Regulamento do PDM de ${municipality}`, version_label: f.version || null, published_on: f.date || null,
    source_url: f.url, storage_path: path, size_bytes: buf.byteLength, found_by: "ia", status: "encontrado", created_by: user,
    notes: [f.page ? `Página da câmara: ${f.page}` : null, f.notes].filter(Boolean).join(" · ") || null,
  }) });
  return row[0];
}

// ---------- ler um PDF da biblioteca com o Gemini (Files API; o ficheiro dura 48 h no Google) ----------
async function geminiFile(doc: any) {
  if (doc.gemini_uri && doc.gemini_expires && new Date(doc.gemini_expires).getTime() - Date.now() > 3600e3) return doc.gemini_uri;
  const dl = await fetch(`${SB_URL}/storage/v1/object/pdm-docs/${doc.storage_path}`, { headers: storageAuth });
  if (!dl.ok) throw new Error("Não foi possível ler o PDF do regulamento guardado");
  const buf = new Uint8Array(await dl.arrayBuffer());
  const start = await fetch(`${API}/upload/v1beta/files`, { method: "POST", headers: {
    "x-goog-api-key": KEY, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Header-Content-Length": String(buf.byteLength), "X-Goog-Upload-Header-Content-Type": "application/pdf", "Content-Type": "application/json",
  }, body: JSON.stringify({ file: { display_name: cut(doc.title || "PDM", 100) } }) });
  const upUrl = start.headers.get("x-goog-upload-url");
  if (!upUrl) throw new Error("O Google não aceitou o envio do PDF: " + (await start.text()).slice(0, 200));
  const fin = await fetch(upUrl, { method: "POST", headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "Content-Length": String(buf.byteLength) }, body: buf });
  const fj = await fin.json();
  let file = fj.file;
  for (let i = 0; i < 30 && file?.state === "PROCESSING"; i++) { await sleep(2000); file = await fetch(`${API}/v1beta/${file.name}`, { headers: { "x-goog-api-key": KEY } }).then((r) => r.json()); }
  if (!file?.uri || file.state === "FAILED") throw new Error("O Google não conseguiu ler o PDF do regulamento");
  await rest(`pdm_library?id=eq.${doc.id}`, { method: "PATCH", body: JSON.stringify({ gemini_uri: file.uri, gemini_expires: file.expirationTime || new Date(Date.now() + 47 * 3600e3).toISOString() }) });
  return file.uri;
}

// ---------- análise estruturada ----------
// O que destacar em cada tipologia (o resto da análise é igual para todas)
const PROFILES: Record<string, string> = {
  multifamiliar: "Habitação multifamiliar: dá destaque a estacionamento (dotação mínima por fogo e/ou por área, lugares para visitantes, dimensões dos lugares e acessos), índice de construção e área de construção, cérceas e número de pisos acima e abaixo do solo, implantação, afastamentos, cedências para espaços verdes, equipamentos e arruamentos, áreas permeáveis, usos compatíveis no piso térreo (comércio/serviços).",
  unifamiliar: "Habitação unifamiliar / moradias: dá destaque a área mínima de parcela/lote, frente mínima, implantação e índice de ocupação, número de pisos e cércea, afastamentos laterais e de tardoz, anexos, impermeabilização, estacionamento no interior do lote, operação de loteamento (se houver divisão em lotes) e cedências.",
  reabilitacao: "Reabilitação: dá destaque a regras de proteção do edificado existente, alinhamentos e cérceas dominantes da frente urbana, ampliações admitidas, património e zonas de proteção (ZEP), ARU e benefícios, isenções/dispensas de estacionamento, manutenção de fachadas, regime de edificação existente (garantia do existente) e normas transitórias de edificação.",
  hotel: "Turismo / hotel: dá destaque a usos turísticos admitidos na categoria de espaço, índices e cérceas para turismo, estacionamento por quarto/unidade de alojamento e para cargas/descargas e autocarros, compatibilidade com habitação, ruído e zonamento acústico, e regimes específicos de empreendimentos turísticos.",
  industria: "Indústria / logística: dá destaque a usos industriais e de armazenagem admitidos, índice de impermeabilização, implantação, altura máxima das naves, afastamentos a vias e limites, estacionamento de ligeiros e pesados, cargas e descargas, cortinas arbóreas, compatibilidade de usos e ruído.",
  comercial: "Comércio / serviços: dá destaque a usos admitidos, áreas máximas por uso, estacionamento por área de venda/serviço e para cargas, cérceas, implantação e compatibilidade com a envolvente.",
  misto: "Uso misto: dá destaque à combinação de usos admitida (percentagens máximas/mínimas por uso), estacionamento por uso, índices, cérceas e compatibilidade de usos no mesmo edifício.",
  capacidade: "Otimização de capacidade construtiva: dá destaque a todos os parâmetros que limitam a área de construção (índices, implantação, cércea, pisos, afastamentos, cedências), ao parâmetro que efetivamente limita e às margens de otimização admitidas (ex.: pisos recuados, caves, majorações por usos ou eficiência).",
  geral: "Tipologia não indicada: faz uma análise geral de todos os parâmetros urbanísticos.",
};
function profileOf(typology: string) {
  const t = slug(typology || "");
  if (/multifamiliar|coletiva/.test(t)) return PROFILES.multifamiliar;
  if (/unifamiliar|moradia/.test(t)) return PROFILES.unifamiliar;
  if (/reabilita/.test(t)) return PROFILES.reabilitacao;
  if (/turismo|hotel/.test(t)) return PROFILES.hotel;
  if (/industria|logistica/.test(t)) return PROFILES.industria;
  if (/comercial|comercio/.test(t)) return PROFILES.comercial;
  if (/misto/.test(t)) return PROFILES.misto;
  if (/capacidade/.test(t)) return PROFILES.capacidade;
  return PROFILES.geral;
}
const SYSTEM_ANALYSE = `És um arquiteto urbanista português a preparar, para a NOVA Associates, o enquadramento urbanístico de um prédio para entregar a um promotor imobiliário. Escreves em português europeu, registo técnico, frases curtas.
REGRAS DE RIGOR (obrigatórias):
1. Nunca inventes valores, artigos, diplomas, datas nem links. Cada parâmetro tem de citar o artigo exato e a fonte. Se não encontrares no regulamento fornecido, o valor fica vazio e o grau é "c" com a indicação "não confirmado".
2. Grau de certeza de cada valor: "a" = confirmado no texto do regulamento/diploma fornecido (cita artigo); "b" = interpretação tua a partir do texto (explica); "c" = depende de verificação nas plantas ou junto da câmara.
3. O estado de vigência da legislação geral é o do REGISTO DE REGIMES LEGAIS fornecido. Não afirmes que uma norma está em vigor ou revogada para além do que o registo diz. Se o registo disser "a_validar", trata o estado como não confirmado, diz isso e aplica a hipótese mais conservadora (a regra mais exigente).
4. Quando o PDM for ambíguo ou houver sobreposição de regimes (PDM, RJUE, regulamento municipal, RGEU/Código da Construção), assinala o conflito, diz qual prevalece e porquê, ou marca "a validar juridicamente".
5. Usa os conceitos técnicos do Decreto Regulamentar 5/2019 e confirma se as definições do PDM coincidem (área de construção, implantação, cércea, índices).
6. Não faças contas de capacidade construtiva: devolve os parâmetros; as contas são feitas pela aplicação. Os parâmetros terminados em _pct vão em percentagem (70 = 70%), os índices em fração (0,8).
7. Adapta a análise à tipologia de investimento indicada.
8. Termina sempre com pontos a validar com a Câmara (incluindo que regime transitório a câmara está a aplicar na prática e a oportunidade de um pedido de informação prévia).
ESTILO (o texto vai para o Cliente, assinado pela NOVA; tem de soar escrito por uma pessoa da equipa):
- Escreve como um arquiteto sénior a explicar a um investidor: claro, direto, sereno e seguro. Português de Portugal.
- Frases completas e naturais, de comprimento variado. Parágrafos curtos que se encadeiam com lógica: o que o regulamento diz, o que isso implica para o prédio, o que se recomenda.
- Vai ao essencial e diz o que interessa ao investimento: o que se pode construir, o que limita, o que falta confirmar e porquê.
- Evita as fórmulas típicas de texto automático: «Em suma», «Em resumo», «É importante salientar», «Importa referir», «Vale a pena», «De salientar», «Neste contexto», «No que diz respeito a», «crucial», «fundamental», «robusto», «abrangente», «potenciar», «alavancar», «em última análise».
- Sem listas de três adjetivos, frases de efeito, perguntas retóricas, pontos de exclamação, emojis, negrito, títulos ou listas dentro dos textos, nem travessões a ligar frases.
- Nunca fales do processo nem de ti: não escrevas «a IA», «o modelo», «os dados fornecidos», «o formulário», «o registo de regimes legais», «grau a/b/c», nem nomes técnicos de campos (cercea_m, a_validar, amarelo…). Quando o estado de uma lei não estiver confirmado, diz-o em linguagem normal («a entrada em vigor ainda não está confirmada; por prudência, adota-se a regra mais exigente»).
- Refere «a NOVA» ou usa a forma impessoal; «o Cliente» com maiúscula.
- Números à portuguesa (1 200 m², 0,70, 21 m) e artigos citados na forma habitual (artigo 27.º, n.º 1, alínea c)).
- Em risk_reason explica a razão em uma ou duas frases, sem nomear a cor.
- Não repitas a mesma informação em secções diferentes.`;
const STR = { type: "STRING" }, NUM = { type: "NUMBER", nullable: true }, BOOL = { type: "BOOLEAN" };
const GRADE = { type: "STRING", enum: ["a", "b", "c"] };
const SCHEMA_ANALYSE = {
  type: "OBJECT",
  properties: {
    summary: { ...STR, description: "Sumário executivo: viabilidade urbanística em 5 a 8 linhas" },
    risk: { type: "STRING", enum: ["verde", "amarelo", "vermelho"] }, risk_reason: STR,
    pdm: { type: "OBJECT", properties: { title: STR, version: STR, date: STR, url: STR, other_plans: STR }, required: ["title"] },
    identification: { ...STR, description: "Localização, classificação e qualificação do solo, instrumentos de gestão territorial aplicáveis" },
    constraints: { type: "ARRAY", items: { type: "OBJECT", properties: { name: STR, applies: { type: "STRING", enum: ["sim", "não", "a confirmar"] }, description: STR, article: STR, source: STR, grade: GRADE, impact: STR }, required: ["name", "applies", "grade"] } },
    params: { type: "ARRAY", description: "Parâmetros urbanísticos aplicáveis. key canónica: ic (índice de construção/utilização), io (índice de ocupação/implantação), implantacao_max_m2, implantacao_max_pct, cercea_m, pisos_acima, pisos_abaixo, imperm_pct, permeavel_pct, area_min_lote_m2, frente_min_m, afast_frente_m, afast_lateral_m, afast_tardoz_m, estac_por_fogo, estac_por_100m2, estac_visitantes_pct, estac_por_quarto, cedencia_verdes_m2_por_100m2, cedencia_equip_m2_por_100m2, pe_direito_min_m, area_min_t1_m2, area_min_t2_m2, area_min_t3_m2, outro", items: { type: "OBJECT", properties: {
      key: STR, label: STR, value: STR, num: NUM, unit: STR, article: STR, source: STR, grade: GRADE, impact: STR,
      sensitive_transition: { ...BOOL, description: "true se pode mudar com a transição RGEU → Código da Construção" },
      strict_num: { ...NUM, description: "valor da regra mais exigente quando há dúvida de regime" }, strict_source: STR }, required: ["key", "label", "value", "grade"] } },
    parking: { ...STR, description: "Estacionamento, cedências e espaços exteriores (texto)" },
    uses: { ...STR, description: "Usos admitidos e compatíveis" },
    transition: { type: "OBJECT", properties: {
      status_text: { ...STR, description: "Estado de vigência à data, segundo o registo de regimes" }, regime_adopted: STR, risks: STR, recommendation: STR,
      table: { type: "ARRAY", items: { type: "OBJECT", properties: { param: STR, rgeu: STR, new_rule: STR, stricter: STR, source: STR }, required: ["param"] } } }, required: ["status_text", "regime_adopted"] },
    general_law: { type: "ARRAY", items: { type: "OBJECT", properties: { topic: STR, rule: STR, diploma: STR, article: STR, impact: STR }, required: ["topic", "rule"] } },
    restrictions: { type: "ARRAY", description: "Lista consolidada de restrições a respeitar no projeto", items: { type: "OBJECT", properties: { param: STR, value: STR, article: STR, source: STR, impact: STR, grade: GRADE }, required: ["param", "value"] } },
    conflicts: { type: "ARRAY", items: { type: "OBJECT", properties: { issue: STR, prevails: STR, why: STR }, required: ["issue"] } },
    to_validate: { type: "ARRAY", items: STR },
    sources: { type: "ARRAY", items: { type: "OBJECT", properties: { title: STR, url: STR, date: STR, kind: { type: "STRING", enum: ["pdm", "diario_republica", "municipal", "outra"] } }, required: ["title"] } },
  },
  required: ["summary", "risk", "pdm", "identification", "constraints", "params", "parking", "transition", "general_law", "restrictions", "to_validate", "sources"],
};
// A análise vai em dois pedidos em paralelo (cada um com metade do relatório): um pedido só, com um regulamento
// longo, passa dos 150 s que o Supabase dá a cada função
const PART_A = ["summary", "risk", "risk_reason", "pdm", "identification", "constraints", "params", "parking", "uses"];
const PART_B = ["transition", "general_law", "restrictions", "conflicts", "to_validate", "sources"];
const schemaOf = (keys: string[]) => ({ type: "OBJECT", properties: Object.fromEntries(keys.map((k) => [k, (SCHEMA_ANALYSE.properties as any)[k]])), required: SCHEMA_ANALYSE.required.filter((k) => keys.includes(k)) });
async function analyse(user: string | null, b: any) {
  const regimes = await restJson("legal_regimes?select=id,name,short,diploma,status,published_on,in_force_on,revoked_on,articles_affected,transitional,scope,source_url,version,checked_at,verified_at,notes&order=sort");
  let doc: any = null;
  if (b.pdm_doc_id) doc = (await restJson(`pdm_library?id=eq.${b.pdm_doc_id}&select=*`))[0] || null;
  const parts: any[] = [];
  if (doc?.storage_path) parts.push({ file_data: { mime_type: "application/pdf", file_uri: await geminiFile(doc) } });
  const today = new Date().toISOString().slice(0, 10);
  parts.push({ text: [
    `DATA DA ANÁLISE: ${today}`,
    `TIPOLOGIA DE INVESTIMENTO: ${cut(b.typology || "não indicada", 200)}`,
    `O QUE DESTACAR NESTA TIPOLOGIA: ${profileOf(b.typology || "")}`,
    "",
    doc ? `REGULAMENTO DO PDM (ficheiro anexo): ${doc.title || ""} · versão ${doc.version_label || "não indicada"} · data ${doc.published_on || "não indicada"} · fonte ${doc.source_url || "carregado pela equipa"}${doc.status === "verificado" ? " · verificado pela equipa" : " · ainda não verificado pela equipa"}`
      : "REGULAMENTO DO PDM: não disponível. Não inventes artigos do PDM: os parâmetros do PDM ficam com grau c e «não confirmado», e pede o regulamento nos pontos a validar.",
    "",
    "DADOS DO PRÉDIO E DO FORMULÁRIO (preenchidos pela equipa a partir das plantas):",
    cut(JSON.stringify(b.input || {}, null, 1), 12000),
    "",
    "EXTRATOS COLADOS PELA EQUIPA:",
    (Array.isArray(b.extracts) ? b.extracts : []).slice(0, 30).map((x: any) => `### ${cut(x.reg, 120)} ${cut(x.art, 80)}\n${cut(x.text, 8000)}`).join("\n\n") || "(nenhum)",
    "",
    "REGISTO DE REGIMES LEGAIS (fonte única do estado de vigência; não o contradigas):",
    JSON.stringify(regimes, null, 1),
  ].join("\n") });
  const ask = (keys: string[], focus: string) => gemini("analyse", user, { systemInstruction: { parts: [{ text: SYSTEM_ANALYSE }] },
    contents: [{ role: "user", parts: [...parts, { text: `NESTE PEDIDO devolve só: ${focus}. Sê conciso: frases curtas, sem repetir o regulamento.` }] }],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: schemaOf(keys), maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: "low" } } });
  const [ga, gb] = await Promise.all([
    ask(PART_A, "sumário, risco, PDM consultado, identificação, condicionantes, parâmetros urbanísticos, estacionamento e usos"),
    ask(PART_B, "enquadramento legal transitório (RGEU → Código da Construção), legislação geral, restrições consolidadas, conflitos, pontos a validar com a Câmara e fontes"),
  ]);
  let out: any; try { out = { ...JSON.parse(ga.text), ...JSON.parse(gb.text) }; } catch { throw new Error("Resposta da IA ilegível"); }
  const g = ga;
  // fotografia do regime legal com que a análise foi feita
  const snapshot = regimes.map((r: any) => ({ id: r.id, short: r.short || r.name, status: r.status, version: r.version, in_force_on: r.in_force_on, revoked_on: r.revoked_on, checked_at: r.checked_at, verified_at: r.verified_at }));
  const checked = regimes.map((r: any) => r.checked_at || r.verified_at).filter(Boolean).sort().pop() || null;
  return { report: out, model: g.model, regime_snapshot: snapshot, regime_checked_at: checked, pdm_doc_id: doc?.id || null };
}

// ---------- rascunho simples (versão anterior) ----------
const SYSTEM_DRAFT = `És um arquiteto português a redigir o enquadramento urbanístico de um terreno para um relatório técnico da NOVA Associates. Português de Portugal, registo técnico. Usa só a informação dada; não inventes valores, artigos nem normas; quando faltar um dado escreve «[a confirmar]». Devolve JSON com ident, classif, params e concl (um a três parágrafos cada).`;
const SCHEMA_DRAFT = { type: "OBJECT", properties: { ident: STR, classif: STR, params: STR, concl: STR }, required: ["ident", "classif", "params", "concl"] };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    if (b.action === "status") {
      const names = Object.keys(Deno.env.toObject()).filter((n) => /GEMINI|GOOGLE|GENAI|AI_?KEY/i.test(n));
      return json({ configured: !!KEY, keyNames: names, model: MODELS[0], usage: await usage() });
    }
    if (!KEY) return json({ error: "no_key" }, 400);
    if (b.action === "models") {
      const r = await fetch(`${API}/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": KEY } }).then((r) => r.json());
      return json({ models: (r.models || []).filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m: any) => m.name.replace("models/", "")) });
    }
    const user = userOf(req);
    try {
      if (b.action === "find_pdm") {
        const mun = cut(b.municipality, 80).trim();
        if (!mun) return json({ error: "Falta o concelho" }, 400);
        const f = await findPdm(user, mun, cut(b.typology, 100));
        if (!f.found) return json({ found: false, searched: f.searched, tried: f.tried, web: f.web, notes: f.notes, hint: f.hint, usage: await usage() });
        // já está na biblioteca?
        const same = await restJson(`pdm_library?source_url=eq.${encodeURIComponent(f.url)}&select=*`).catch(() => []);
        const doc = same[0] || await storePdm(user, mun, f);
        return json({ found: true, searched: f.searched, page: f.page, doc, usage: await usage() });
      }
      // Análise em segundo plano: responde já com o n.º do trabalho e grava o resultado em ai_jobs (a app vai consultando);
      // assim um regulamento longo não esbarra no limite de 150 s de um pedido
      if (b.action === "analyse_start") {
        const job = (await restJson("ai_jobs", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ kind: "analyse", user_id: user }) }))[0];
        // o Supabase corta a função aos 150 s: antes disso o trabalho fica marcado como falhado (em vez de «a correr» para sempre)
        const guard = setTimeout(() => { rest(`ai_jobs?id=eq.${job.id}&status=eq.a_correr`, { method: "PATCH", body: JSON.stringify({ status: "erro", error_code: "timeout", error: "A análise passou do tempo máximo do servidor (150 s).", finished_at: new Date().toISOString() }) }); }, 140000);
        const run = (async () => {
          try { const r = await analyse(user, b); await rest(`ai_jobs?id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ status: "ok", result: { ...r, usage: await usage() }, finished_at: new Date().toISOString() }) }); }
          catch (e) { await rest(`ai_jobs?id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ status: "erro", error: cut((e as Error).message, 500), error_code: e instanceof AiError ? e.code : null, result: e instanceof AiError && e.extra ? { quota: e.extra } : null, finished_at: new Date().toISOString() }) }); }
          finally { clearTimeout(guard); }
        })();
        if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(run); else await run;
        return json({ job: job.id });
      }
      if (b.action === "analyse") {
        const r = await analyse(user, b);
        return json({ ...r, usage: await usage() });
      }
      if (b.action === "draft") {
        const prompt = ["DADOS DO TERRENO", cut(JSON.stringify(b.facts ?? {}, null, 1), 4000), "", "CONDICIONANTES", cut(JSON.stringify(b.constraints ?? {}, null, 1), 6000), "",
          "PLANTAS (legendas)", (Array.isArray(b.plants) ? b.plants : []).map((x: unknown) => "- " + cut(x, 200)).join("\n") || "(nenhuma)", "",
          "EXTRATOS", (Array.isArray(b.extracts) ? b.extracts : []).slice(0, 30).map((x: any) => `### ${cut(x.reg, 120)} ${cut(x.art, 80)}\n${cut(x.text, 12000)}`).join("\n\n") || "(nenhum)"].join("\n");
        const g = await gemini("draft", user, { systemInstruction: { parts: [{ text: SYSTEM_DRAFT }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, responseMimeType: "application/json", responseSchema: SCHEMA_DRAFT } });
        const out = JSON.parse(g.text);
        return json({ ident: out.ident || "", classif: out.classif || "", params: out.params || "", concl: out.concl || "", usage: await usage() });
      }
      return json({ error: "Ação desconhecida" }, 400);
    } catch (e) {
      if (e instanceof AiError && e.code === "limit") return json({ error: "limit", quota: e.extra, usage: await usage() }, 429);
      if (e instanceof AiError && e.code === "busy") return json({ error: "busy" }, 502);
      if (e instanceof AiError && e.code === "plan") return json({ error: "plan" }, 402);
      throw e;
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
