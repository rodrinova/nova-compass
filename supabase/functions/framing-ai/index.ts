// Enquadramento urbanístico: o Gemini (Google, plano gratuito) escreve um rascunho das secções do relatório
// a partir dos dados do terreno, das condicionantes e dos extratos colados (PDM, RMUE…). A equipa revê sempre.
// Segredos: GEMINI_API_KEY (Google AI Studio; também se aceitam GOOGLE_API_KEY e GEMINI_KEY); GEMINI_MODEL opcional.
// No plano gratuito o Google pode usar os textos para melhorar os modelos: só se enviam dados do terreno e
// extratos de regulamentos públicos, nunca dados de clientes.
// Cada pedido fica em ai_usage (tokens e, no limite, a quota que o Google indica) para o indicador de utilização.
const KEY_NAMES = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_AI_API_KEY"];
const KEY = (KEY_NAMES.map((n) => Deno.env.get(n)).find((v) => v && v.trim()) ?? "").trim();
const MODELS = [Deno.env.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-2.5-flash"].filter(Boolean) as string[];
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "", SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `És um arquiteto português a redigir o enquadramento urbanístico de um terreno para um relatório técnico da NOVA Associates.
Regras:
- Português de Portugal, registo técnico, frases curtas e objetivas. Sem adjetivos promocionais nem conclusões comerciais.
- Usa só a informação dada (dados do terreno, condicionantes e extratos). Não inventes valores, artigos nem normas.
- Foca-te nos parâmetros urbanísticos: classe de espaço, índices, número de pisos, cércea, afastamentos, áreas, estacionamento e condicionantes (REN, RAN, ARU, UOPG, servidões).
- Quando citares um extrato, indica o regulamento e o artigo (ex.: «art. 42.º do Regulamento do PDM»).
- Quando faltar um dado necessário, escreve «[a confirmar]» em vez de supor.
- Não repitas o mesmo conteúdo em secções diferentes. Sem títulos, sem listas com marcadores, sem markdown além de **negrito** pontual.
Devolve JSON com quatro textos:
- ident: identificação e localização do terreno (1 parágrafo);
- classif: classificação no PDM e condicionantes que se aplicam (1 a 2 parágrafos);
- params: parâmetros urbanísticos aplicáveis e capacidade construtiva resultante (1 a 3 parágrafos);
- concl: conclusão sobre o que o enquadramento permite e o que falta confirmar junto da Câmara (1 parágrafo).`;

const SCHEMA = {
  type: "OBJECT",
  properties: { ident: { type: "STRING" }, classif: { type: "STRING" }, params: { type: "STRING" }, concl: { type: "STRING" } },
  required: ["ident", "classif", "params", "concl"],
};

// O dia do Google (quotas diárias) começa à meia-noite da Califórnia
function pacificMidnightUtc(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = asUtc - now.getTime();                      // diferença entre a hora da Califórnia e UTC
  const start = Date.UTC(parts.year, parts.month - 1, parts.day) - offset;
  return { start: new Date(start), next: new Date(start + 864e5) };
}
const rest = (path: string, init: RequestInit = {}) => fetch(`${SB_URL}/rest/v1/${path}`, {
  ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", ...(init.headers || {}) },
});
const userOf = (req: Request) => {
  try { const t = (req.headers.get("Authorization") || "").split(".")[1]; const p = JSON.parse(atob(t.replace(/-/g, "+").replace(/_/g, "/"))); return p.role === "authenticated" ? p.sub : null; } catch { return null; }
};
async function log(row: Record<string, unknown>) { if (SB_URL && SB_SERVICE) await rest("ai_usage", { method: "POST", body: JSON.stringify(row) }).catch(() => {}); }

async function usage() {
  const { start, next } = pacificMidnightUtc();
  const rows: any[] = SB_URL && SB_SERVICE ? await rest(`ai_usage?select=status,total_tokens,created_at,detail&created_at=gte.${start.toISOString()}&order=created_at.desc`).then((r) => r.json()).catch(() => []) : [];
  const ok = rows.filter((r) => r.status === "ok");
  // o limite diário de pedidos: o último que o Google indicou (de hoje ou de outro dia)
  const lastLimit: any[] = SB_URL && SB_SERVICE ? await rest(`ai_usage?select=detail,created_at&status=eq.limit&order=created_at.desc&limit=1`).then((r) => r.json()).catch(() => []) : [];
  const hitToday = rows.find((r) => r.status === "limit");
  return {
    requests: ok.length, tokens: ok.reduce((t, r) => t + (r.total_tokens || 0), 0), resetAt: next.toISOString(),
    limitHit: hitToday ? { at: hitToday.created_at, ...(hitToday.detail || {}) } : null,
    knownLimit: lastLimit[0]?.detail || null,
  };
}

async function ask(model: string, prompt: string) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, responseMimeType: "application/json", responseSchema: SCHEMA },
    }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}
// No erro 429 o Google diz que quota se esgotou (por dia ou por minuto), o valor e quando voltar a tentar
function quotaOf(body: any) {
  const det = body?.error?.details || [];
  const v = det.flatMap((d: any) => d.violations || [])[0] || {};
  const retry = det.find((d: any) => /RetryInfo/.test(d["@type"] || ""))?.retryDelay || null;
  const id = String(v.quotaId || v.quotaMetric || "");
  return { quota: id || null, value: v.quotaValue != null ? Number(v.quotaValue) : null, perDay: /PerDay/i.test(id), perMinute: /PerMinute/i.test(id), retry, message: String(body?.error?.message || "").slice(0, 300) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    if (b.action === "status") {
      // diagnóstico: que segredos com nome parecido existem (só os nomes, nunca os valores)
      const names = Object.keys(Deno.env.toObject()).filter((n) => /GEMINI|GOOGLE|GENAI|AI_?KEY/i.test(n));
      return json({ configured: !!KEY, keyNames: names, model: MODELS[0], usage: await usage() });
    }
    if (b.action !== "draft") return json({ error: "Ação desconhecida" }, 400);
    if (!KEY) return json({ error: "no_key" }, 400);
    const user = userOf(req);
    // limite de tamanho: os extratos podem ser longos
    const cut = (s: unknown, n: number) => String(s ?? "").slice(0, n);
    const extracts = (Array.isArray(b.extracts) ? b.extracts : []).slice(0, 30)
      .map((x: any) => `### ${cut(x.reg, 120)}${x.art ? " — " + cut(x.art, 80) : ""}\n${cut(x.text, 12000)}`).join("\n\n");
    const prompt = [
      "DADOS DO TERRENO",
      cut(JSON.stringify(b.facts ?? {}, null, 1), 4000),
      "",
      "CONDICIONANTES E PARÂMETROS PREENCHIDOS NA FICHA",
      cut(JSON.stringify(b.constraints ?? {}, null, 1), 6000),
      "",
      "PLANTAS ANEXAS (legendas)",
      (Array.isArray(b.plants) ? b.plants : []).map((x: unknown) => "- " + cut(x, 200)).join("\n") || "(nenhuma)",
      "",
      "EXTRATOS DA LEGISLAÇÃO",
      cut(extracts, 60000) || "(nenhum)",
      "",
      b.notes ? "NOTAS DA EQUIPA\n" + cut(b.notes, 3000) : "",
    ].join("\n");
    let last: { status: number; body: any } | null = null, model = MODELS[0];
    // 404: o modelo já não existe; 503: o Google está sobrecarregado (temporário) — tenta outra vez e depois o modelo seguinte
    for (const m of MODELS) {
      model = m;
      last = await ask(m, prompt);
      if (last.status === 503) { await new Promise((r) => setTimeout(r, 1500)); last = await ask(m, prompt); }
      if (last.status === 404 || last.status === 503) continue;
      break;
    }
    if (!last || last.status !== 200) {
      if (last?.status === 429) {
        const q = quotaOf(last.body);
        await log({ user_id: user, model, status: "limit", detail: q });
        return json({ error: "limit", quota: q, usage: await usage() }, 429);
      }
      const msg = last?.body?.error?.message || `Erro ${last?.status}`;
      await log({ user_id: user, model, status: "error", detail: { status: last?.status, message: String(msg).slice(0, 300) } });
      return json({ error: last?.status === 503 ? "busy" : msg }, 502);
    }
    const um = last.body?.usageMetadata || {};
    await log({ user_id: user, model, status: "ok", prompt_tokens: um.promptTokenCount ?? null, output_tokens: um.candidatesTokenCount ?? null, total_tokens: um.totalTokenCount ?? null });
    const txt = last.body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
    let out: Record<string, string>;
    try { out = JSON.parse(txt); } catch { return json({ error: "Resposta da IA ilegível" }, 502); }
    return json({ ident: out.ident || "", classif: out.classif || "", params: out.params || "", concl: out.concl || "", usage: await usage() });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
