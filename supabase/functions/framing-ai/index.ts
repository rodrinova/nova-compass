// Enquadramento urbanístico: o Gemini (Google, plano gratuito) escreve um rascunho das secções do relatório
// a partir dos dados do terreno, das condicionantes e dos extratos colados (PDM, RMUE…). A equipa revê sempre.
// Segredos: GEMINI_API_KEY (Google AI Studio); GEMINI_MODEL opcional (por omissão, o Flash mais recente).
// No plano gratuito o Google pode usar os textos para melhorar os modelos: só se enviam dados do terreno e
// extratos de regulamentos públicos, nunca dados de clientes.
const KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODELS = [Deno.env.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-2.5-flash"].filter(Boolean) as string[];
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    if (b.action === "status") return json({ configured: !!KEY });
    if (b.action !== "draft") return json({ error: "Ação desconhecida" }, 400);
    if (!KEY) return json({ error: "no_key" }, 400);
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
    let last: { status: number; body: any } | null = null;
    for (const m of MODELS) {
      last = await ask(m, prompt);
      if (last.status === 404) continue;   // modelo que já não existe: tenta o seguinte
      break;
    }
    if (!last || last.status !== 200) {
      const msg = last?.body?.error?.message || `Erro ${last?.status}`;
      return json({ error: last?.status === 429 ? "limit" : msg }, last?.status === 429 ? 429 : 502);
    }
    const txt = last.body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
    let out: Record<string, string>;
    try { out = JSON.parse(txt); } catch { return json({ error: "Resposta da IA ilegível" }, 502); }
    return json({ ident: out.ident || "", classif: out.classif || "", params: out.params || "", concl: out.concl || "" });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
