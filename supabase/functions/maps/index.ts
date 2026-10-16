// Mapa das oportunidades: dá a chave do Google Maps à app (só a quem tem sessão iniciada), abre os links curtos
// do Google Maps (maps.app.goo.gl) e encontra a morada de um ponto (Google; sem chave, OpenStreetMap).
// Segredo: GOOGLE_MAPS_KEY (chave de browser, restrita ao site da app).
const KEY = Deno.env.get("GOOGLE_MAPS_KEY") ?? "";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { ...cors, "Content-Type": "application/json" } });
const GOOGLE = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)/i;

async function expand(url: string) {
  if (!GOOGLE.test(url)) throw new Error("Não é um link do Google Maps");
  let u = url;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(u, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (NOVA Compass)" } });
    const loc = r.headers.get("location");
    if (!loc || r.status < 300 || r.status >= 400) break;
    u = new URL(loc, u).href;
  }
  return u;
}

type Addr = { address: string | null; parish: string | null; municipality: string | null; postal: string | null; formatted: string | null };
async function reverse(lat: number, lng: number): Promise<Addr> {
  if (KEY) {
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=pt-PT&key=${KEY}`).then((x) => x.json());
    const res = (r.results || [])[0];
    if (res) {
      const all = (r.results || []).flatMap((x: any) => x.address_components || []);
      const get = (t: string) => (res.address_components || []).find((c: any) => c.types.includes(t))?.long_name || all.find((c: any) => c.types.includes(t))?.long_name || null;
      const road = get("route"), num = get("street_number");
      return { address: road ? [road, num].filter(Boolean).join(", ") : null, parish: get("administrative_area_level_3") || get("sublocality") || get("locality"),
        municipality: get("administrative_area_level_2") || get("locality"), postal: get("postal_code"), formatted: res.formatted_address || null };
    }
  }
  const n = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=pt&addressdetails=1`, { headers: { "User-Agent": "NOVA Compass (novassociates.com)" } }).then((x) => x.json());
  const a = n.address || {};
  return { address: a.road ? [a.road, a.house_number].filter(Boolean).join(", ") : null, parish: a.city_district || a.suburb || a.village || a.town || null,
    municipality: a.municipality || a.city || a.town || a.county || null, postal: a.postcode || null, formatted: n.display_name || null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    if (b.action === "key") return json({ key: KEY || null });
    if (b.action === "expand") return json({ url: await expand(String(b.url || "")) });
    if (b.action === "reverse") {
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json({ error: "Coordenadas inválidas" }, 400);
      return json(await reverse(lat, lng));
    }
    return json({ error: "Ação desconhecida" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
