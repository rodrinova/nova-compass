// NOVA Compass — análise de ofícios e informações da Câmara com o Gemini (Google). A equipa revê sempre.
// Ações:
//   analyse_start { document_id } — lê o documento escolhido e todo o histórico do processo carregado no projeto
//       (memória descritiva, ofícios, informações, pareceres) e explica, de forma sintética, o que está a ser pedido,
//       citando o documento e o sítio (página, ponto) de cada afirmação. Corre em segundo plano: o resultado fica em
//       municipal_documents.analysis (analysis_status: a_correr → ok | erro) e a app vai consultando.
//   client_report { document_id } — a partir da análise, escreve o relatório para o cliente (leigo): linguagem simples,
//       natural e profissional. Fica em municipal_documents.client_report; a equipa edita na app antes de exportar.
// Segredos: GEMINI_API_KEY (também GOOGLE_API_KEY…), o mesmo do Enquadramento; GEMINI_MODEL opcional.
// Acesso: só a equipa (o documento é lido com a sessão de quem pede, pelas regras da base de dados).
const KEY_NAMES = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_AI_API_KEY"];
const KEY = (KEY_NAMES.map((n) => Deno.env.get(n)).find((v) => v && v.trim()) ?? "").trim();
const MODELS = [...new Set([Deno.env.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash"].filter(Boolean) as string[])];
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "", SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const API = "https://generativelanguage.googleapis.com";
const MAX_DOCS = 24;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { ...cors, "Content-Type": "application/json" } });
const cut = (s: unknown, n: number) => String(s ?? "").slice(0, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

// ---------- base de dados (service role) ----------
const rest = (path: string, init: RequestInit = {}) => fetch(`${SB_URL}/rest/v1/${path}`, {
  ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", ...(init.headers || {}) },
});
const restJson = async (path: string, init: RequestInit = {}) => { const r = await rest(path, init); const t = await r.text(); if (!r.ok) throw new Error(`BD ${r.status}: ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null; };
const storageAuth: Record<string, string> = SB_SERVICE.startsWith("eyJ") ? { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` } : { apikey: SB_SERVICE };
const userOf = (req: Request) => {
  try { const t = (req.headers.get("Authorization") || "").split(".")[1]; const p = JSON.parse(atob(t.replace(/-/g, "+").replace(/_/g, "/"))); return p.role === "authenticated" ? p.sub : null; } catch { return null; }
};
// O documento lido com a sessão de quem pede: se as regras (só a equipa) não o deixarem ver, não há análise
async function canSee(req: Request, id: string) {
  const r = await fetch(`${SB_URL}/rest/v1/municipal_documents?id=eq.${encodeURIComponent(id)}&select=id`, { headers: { apikey: SB_ANON || SB_SERVICE, Authorization: req.headers.get("Authorization") || "" } });
  if (!r.ok) return false;
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length === 1;
}
async function log(row: Record<string, unknown>) { if (SB_URL && SB_SERVICE) await rest("ai_usage", { method: "POST", body: JSON.stringify(row) }).catch(() => {}); }
const patchDoc = (id: string, patch: Record<string, unknown>) => rest(`municipal_documents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) });

// ---------- Gemini (com novas tentativas e modelo seguinte quando está sobrecarregado) ----------
class AiError extends Error { constructor(public code: string, msg: string) { super(msg); } }
async function gemini(feature: string, user: string | null, body: Record<string, unknown>, perCallMs: number, deadline: number) {
  let last: { status: number; body: any; ms?: number } | null = null, model = MODELS[0];
  for (const m of MODELS) {
    model = m;
    for (let i = 0; i < 2; i++) {
      const left = deadline - Date.now();
      if (left < 15000) throw new AiError("busy", "Sem tempo para mais uma tentativa");
      const t0 = Date.now();
      let r: Response;
      try { r = await fetch(`${API}/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(perCallMs, left - 5000)) }); }
      catch { last = { status: 504, body: { error: { message: `O modelo ${m} não respondeu a tempo` } }, ms: Date.now() - t0 }; await log({ user_id: user, model: m, feature, status: "error", detail: { status: 504, ms: last.ms } }); break; }
      last = { status: r.status, body: await r.json().catch(() => ({})), ms: Date.now() - t0 };
      const tc = (body as any).generationConfig?.thinkingConfig;
      if (last.status === 400 && tc && /thinking/i.test(last.body?.error?.message || "")) {
        body = { ...body, generationConfig: { ...(body as any).generationConfig, thinkingConfig: tc.thinkingLevel ? { thinkingBudget: 1024 } : undefined } }; i--; continue;
      }
      if (last.status !== 503) break;
      await sleep(1500);
    }
    const skip = last.status === 404 || last.status === 503 || last.status === 504 || (last.status === 400 && /no longer available|not found|not supported/i.test(last.body?.error?.message || ""))
      || (last.status === 429 && /per.?day|daily|billing|plan/i.test(JSON.stringify(last.body?.error || {})));
    if (skip) continue;
    break;
  }
  if (!last || last.status !== 200) {
    const msg = last?.body?.error?.message || `Erro ${last?.status}`;
    await log({ user_id: user, model, feature, status: last?.status === 429 ? "limit" : "error", detail: { status: last?.status, message: cut(msg, 300) } });
    throw new AiError(last?.status === 429 ? "limit" : last?.status === 503 || last?.status === 504 ? "busy" : "error", msg);
  }
  const um = last.body?.usageMetadata || {};
  await log({ user_id: user, model, feature, status: "ok", prompt_tokens: um.promptTokenCount ?? null, output_tokens: um.candidatesTokenCount ?? null, total_tokens: um.totalTokenCount ?? null, detail: { ms: last.ms, version: last.body?.modelVersion || null } });
  const cand = last.body?.candidates?.[0] || {};
  return { model, text: (cand.content?.parts || []).map((p: any) => p.text || "").join("") };
}

// ---------- ficheiros do processo no Gemini (Files API; cada ficheiro dura 48 h no Google, o link fica guardado) ----------
async function geminiFile(doc: any) {
  if (doc.gemini_uri && doc.gemini_expires && new Date(doc.gemini_expires).getTime() - Date.now() > 3600e3) return doc.gemini_uri;
  const dl = await fetch(`${SB_URL}/storage/v1/object/camara-docs/${doc.path}`, { headers: storageAuth });
  if (!dl.ok) throw new Error(`Não foi possível ler «${doc.title}» do armazenamento`);
  const buf = new Uint8Array(await dl.arrayBuffer());
  const mime = doc.mime || "application/pdf";
  const start = await fetch(`${API}/upload/v1beta/files`, { method: "POST", headers: {
    "x-goog-api-key": KEY, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Header-Content-Length": String(buf.byteLength), "X-Goog-Upload-Header-Content-Type": mime, "Content-Type": "application/json",
  }, body: JSON.stringify({ file: { display_name: cut(doc.title || "documento", 100) } }) });
  const upUrl = start.headers.get("x-goog-upload-url");
  if (!upUrl) throw new Error("O Google não aceitou o envio do documento: " + (await start.text()).slice(0, 200));
  const fin = await fetch(upUrl, { method: "POST", headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "Content-Length": String(buf.byteLength) }, body: buf });
  let file = (await fin.json()).file;
  for (let i = 0; i < 20 && file?.state === "PROCESSING"; i++) { await sleep(1500); file = await fetch(`${API}/v1beta/${file.name}`, { headers: { "x-goog-api-key": KEY } }).then((r) => r.json()); }
  if (!file?.uri || file.state === "FAILED") throw new Error(`O Google não conseguiu ler «${doc.title}»`);
  await patchDoc(doc.id, { gemini_uri: file.uri, gemini_expires: file.expirationTime || new Date(Date.now() + 47 * 3600e3).toISOString() });
  return file.uri as string;
}
async function mapLimit<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>) {
  const out: R[] = new Array(xs.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } }));
  return out;
}

const KIND: Record<string, string> = { oficio: "Ofício da Câmara", informacao: "Informação técnica da Câmara", memoria: "Memória descritiva (do projeto)", parecer: "Parecer de entidade externa", outro: "Outro documento" };
const STR = { type: "STRING" };
const SRC = { type: "OBJECT", properties: { doc: STR, local: STR, citacao: STR }, required: ["doc", "local"] };
const SRCS = { type: "ARRAY", items: SRC };
const SCHEMA_ANALYSIS = {
  type: "OBJECT",
  properties: {
    resumo: STR,
    natureza: STR,
    prazo: { type: "OBJECT", properties: { texto: STR, data: STR, fontes: SRCS }, required: ["texto"] },
    pedidos: { type: "ARRAY", items: { type: "OBJECT", properties: { titulo: STR, o_que_pede: STR, porque: STR, o_que_fazer: STR, quem: STR, fontes: SRCS }, required: ["titulo", "o_que_pede", "o_que_fazer", "fontes"] } },
    historico: { type: "OBJECT", properties: { texto: STR, fontes: SRCS }, required: ["texto"] },
    atencao: { type: "ARRAY", items: { type: "OBJECT", properties: { texto: STR, fontes: SRCS }, required: ["texto"] } },
    duvidas: { type: "ARRAY", items: STR },
  },
  required: ["resumo", "natureza", "prazo", "pedidos", "historico"],
};
const SYSTEM_ANALYSIS = `És um arquiteto sénior português, especialista em licenciamento urbanístico (RJUE, PDM, RGEU/Código da Construção, acessibilidades, segurança contra incêndio, especialidades), a trabalhar na NOVA Associates.
Recebes os documentos do processo camarário de um projeto, identificados como [D1], [D2]… Um deles é o DOCUMENTO A ANALISAR. Os outros são o histórico (memória descritiva, ofícios e informações anteriores, pareceres).
Explica à equipa, de forma sintética e acessível, o que o DOCUMENTO A ANALISAR está a pedir, ligando-o ao histórico.
Regras:
- Português de Portugal. Frases curtas e claras. Sem jargão desnecessário; quando usares um termo técnico, explica-o em poucas palavras.
- Cada afirmação importante tem fonte: doc = o identificador ([D1] → "D1"), local = sítio exato no documento (ex.: "pág. 2, ponto 3.1", "parágrafo 4", "quadro da pág. 5"), citacao = excerto curto e literal (até 25 palavras) quando ajudar.
- Nunca inventes: se algo não está nos documentos, não o afirmes. Põe em "duvidas" o que não se consegue concluir (ex.: prazo omisso, peça referida mas não carregada).
- natureza: o tipo de comunicação em poucas palavras (ex.: "Pedido de elementos / aperfeiçoamento", "Audiência prévia — intenção de indeferimento", "Notificação de deferimento", "Informação técnica desfavorável").
- prazo: o prazo para responder ou agir, como está no documento, e a data limite (AAAA-MM-DD) só se for possível calculá-la com segurança a partir das datas dos documentos; senão data = "".
- pedidos: um por cada ponto distinto do documento, pela ordem do documento. o_que_pede: em linguagem simples. porque: a norma ou a razão invocada e a ligação ao que está no projeto (memória descritiva) ou em ofícios anteriores. o_que_fazer: a resposta concreta que a equipa deve preparar (peças, correções, documentos). quem: "NOVA", "Cliente", "Especialidades", "Entidade externa" ou outro curto.
- historico: como este documento se liga ao que está para trás (se repete pedidos já feitos, se resulta de uma resposta anterior, se contradiz algo).
- atencao: riscos, prazos curtos, possíveis indeferimentos, contradições entre documentos.`;

const SCHEMA_REPORT = {
  type: "OBJECT",
  properties: {
    titulo: STR, introducao: STR, situacao: STR,
    pedidos: { type: "ARRAY", items: { type: "OBJECT", properties: { titulo: STR, explicacao: STR }, required: ["titulo", "explicacao"] } },
    proximos_passos: { type: "ARRAY", items: { type: "OBJECT", properties: { passo: STR, quem: STR, quando: STR }, required: ["passo"] } },
    prazo: STR,
    do_cliente: { type: "ARRAY", items: STR },
    glossario: { type: "ARRAY", items: { type: "OBJECT", properties: { termo: STR, significado: STR }, required: ["termo", "significado"] } },
    fecho: STR,
  },
  required: ["titulo", "introducao", "situacao", "pedidos", "proximos_passos", "prazo", "fecho"],
};
const SYSTEM_REPORT = `Escreves pela NOVA Associates (gabinete de arquitetura e consultoria imobiliária) um relatório para o cliente, dono da obra, que não percebe de arquitetura, de assuntos camarários nem de construção.
Recebes a análise interna de um documento da Câmara (com fontes) e os dados do projeto. Explica ao cliente o que se passa.
Tom: simples, natural, lógico, intuitivo e profissional. Português de Portugal. Trata o cliente com respeito e sem paternalismo ("Recebemos da Câmara…", "O que isto significa…").
Regras:
- Nada de jargão: se for inevitável usar um termo (ex.: "aditamento", "audiência prévia", "especialidades"), explica-o na frase ou no glossário.
- Frases curtas, uma ideia por frase. Parágrafos curtos.
- Não alarmes nem desvalorizes: diz com clareza o que é normal no processo e o que exige atenção.
- Não inventes factos, datas nem custos. Usa só o que está na análise e nos dados.
- Não prometas resultados da Câmara. Não te elogies.
- titulo: curto (ex.: "O que a Câmara pediu e o que vamos fazer"). introducao: 2–3 frases (que documento chegou, de quem, quando). situacao: em que ponto está o processo, em linguagem simples.
- pedidos: um por ponto pedido, com explicação simples do que é e porque é pedido. proximos_passos: o que a NOVA vai fazer, o que depende do cliente e de outros, com prazos se houver. prazo: o prazo de resposta numa frase.
- do_cliente: o que precisamos que o cliente faça ou envie (vazio se nada). glossario: só os termos usados que um leigo pode não conhecer (máximo 6). fecho: 1–2 frases de disponibilidade, sem fórmulas feitas.`;

async function analyse(user: string | null, docId: string, deadline: number) {
  const [target] = await restJson(`municipal_documents?id=eq.${docId}&select=*`);
  if (!target) throw new Error("Documento não encontrado");
  const [proj] = await restJson(`projects?id=eq.${target.project_id}&select=name,code,address,municipality,municipal_process_code`);
  const all: any[] = await restJson(`municipal_documents?project_id=eq.${target.project_id}&select=*&order=doc_date.asc.nullslast,created_at.asc`);
  const follow: any[] = await restJson(`municipal_followups?project_id=eq.${target.project_id}&select=followup_date,status,notes&order=followup_date.asc`).catch(() => []);
  // o documento a analisar, as memórias descritivas e o histórico mais recente (até MAX_DOCS)
  const others = all.filter((d) => d.id !== target.id);
  const mem = others.filter((d) => d.kind === "memoria");
  const rest_ = others.filter((d) => d.kind !== "memoria").slice(-(MAX_DOCS - 1 - Math.min(mem.length, 4)));
  const use = [...new Set([...mem.slice(-4), ...rest_, target])].sort((a, b) => String(a.doc_date || "9999").localeCompare(String(b.doc_date || "9999")) || String(a.created_at).localeCompare(String(b.created_at)));
  const uris = await mapLimit(use, 4, (d) => geminiFile(d));
  const ids = use.map((_, i) => `D${i + 1}`);
  const parts: any[] = [{ text: [
    `PROJETO: ${proj?.name || ""}${proj?.code ? " (" + proj.code + ")" : ""}`,
    `Morada: ${proj?.address || "—"} · Município: ${proj?.municipality || "—"} · N.º do processo: ${proj?.municipal_process_code || "—"}`,
    follow.length ? "TRAMITAÇÃO REGISTADA PELA EQUIPA:\n" + follow.slice(-15).map((f) => `- ${f.followup_date}: ${f.status}${f.notes ? " — " + cut(f.notes, 300) : ""}`).join("\n") : "",
    "DOCUMENTOS DO PROCESSO (por ordem de data):",
    ...use.map((d, i) => `[${ids[i]}] ${KIND[d.kind] || "Documento"} · «${cut(d.title, 160)}»${d.ref_number ? " · n.º " + cut(d.ref_number, 60) : ""}${d.doc_date ? " · " + d.doc_date : " · sem data"}${d.id === target.id ? "   ← DOCUMENTO A ANALISAR" : ""}`),
  ].filter(Boolean).join("\n") }];
  use.forEach((d, i) => { parts.push({ text: `[${ids[i]}]${d.id === target.id ? " (DOCUMENTO A ANALISAR)" : ""}` }); parts.push({ file_data: { mime_type: d.mime || "application/pdf", file_uri: uris[i] } }); });
  parts.push({ text: `Analisa o documento [${ids[use.indexOf(target)]}] à luz de todo o histórico.` });
  const g = await gemini("camara_analyse", user, {
    systemInstruction: { parts: [{ text: SYSTEM_ANALYSIS }] },
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: SCHEMA_ANALYSIS, maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: "low" } },
  }, 100000, deadline);
  const out = JSON.parse(g.text);
  // a correspondência D1… → documento (para a app abrir a fonte certa)
  out.docs = use.map((d, i) => ({ ref: ids[i], id: d.id, title: d.title, kind: d.kind, date: d.doc_date, number: d.ref_number }));
  out.target = ids[use.indexOf(target)];
  return { analysis: out, model: g.model };
}

async function clientReport(user: string | null, docId: string, deadline: number) {
  const [d] = await restJson(`municipal_documents?id=eq.${docId}&select=*`);
  if (!d?.analysis) throw new Error("Primeiro é preciso analisar o documento");
  const [proj] = await restJson(`projects?id=eq.${d.project_id}&select=name,address,municipality,municipal_process_code`);
  const a = d.analysis;
  const prompt = [
    `PROJETO: ${proj?.name || ""} · ${proj?.address || ""} · Município: ${proj?.municipality || "—"} · Processo: ${proj?.municipal_process_code || "—"}`,
    `DOCUMENTO: ${KIND[d.kind] || "Documento"} «${d.title}»${d.ref_number ? " n.º " + d.ref_number : ""}${d.doc_date ? " de " + d.doc_date : ""}`,
    "ANÁLISE INTERNA (revista pela equipa):", cut(JSON.stringify({ resumo: a.resumo, natureza: a.natureza, prazo: a.prazo, pedidos: a.pedidos, historico: a.historico, atencao: a.atencao, duvidas: a.duvidas, docs: a.docs }, null, 1), 30000),
  ].join("\n");
  const g = await gemini("camara_report", user, {
    systemInstruction: { parts: [{ text: SYSTEM_REPORT }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, responseMimeType: "application/json", responseSchema: SCHEMA_REPORT, maxOutputTokens: 6144, thinkingConfig: { thinkingLevel: "low" } },
  }, 80000, deadline);
  return { report: JSON.parse(g.text), model: g.model };
}

const errCode = (e: unknown) => e instanceof AiError ? e.code : null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    if (!KEY) return json({ error: "no_key" }, 400);
    const user = userOf(req);
    const id = cut(b.document_id, 64);
    if (!user || !id || !(await canSee(req, id))) return json({ error: "Sem acesso a este documento" }, 403);
    const deadline = Date.now() + 140000;   // o Supabase corta a função aos 150 s
    if (b.action === "analyse_start") {
      await patchDoc(id, { analysis_status: "a_correr", analysis_error: null, analysis_started_at: new Date().toISOString() });
      const guard = setTimeout(() => { rest(`municipal_documents?id=eq.${id}&analysis_status=eq.a_correr`, { method: "PATCH", body: JSON.stringify({ analysis_status: "erro", analysis_error: "timeout" }) }); }, 145000);
      const run = (async () => {
        try {
          const r = await analyse(user, id, deadline);
          await patchDoc(id, { analysis: r.analysis, analysis_status: "ok", analysis_error: null, analysis_model: r.model, analysis_at: new Date().toISOString(), analysis_by: b.member_id || null });
        } catch (e) { await patchDoc(id, { analysis_status: "erro", analysis_error: errCode(e) || cut((e as Error).message, 400) }); }
        finally { clearTimeout(guard); }
      })();
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(run); else await run;
      return json({ started: true });
    }
    if (b.action === "client_report") {
      try {
        const r = await clientReport(user, id, deadline);
        const row = { ...r.report, _original: r.report };
        await patchDoc(id, { client_report: row, client_report_at: new Date().toISOString() });
        return json({ report: row });
      } catch (e) {
        const c = errCode(e);
        if (c === "limit") return json({ error: "limit" }, 429);
        if (c === "busy") return json({ error: "busy" }, 502);
        throw e;
      }
    }
    return json({ error: "Ação desconhecida" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
