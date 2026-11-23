// A agenda de uma pessoa (Outlook/Teams, lida pela ms365-sync para ms_events) em .ics, para subscrever noutra app
// (ex.: a NIKKI). GET /functions/v1/agenda-ics?t=<link secreto da pessoa> (public.ics_feeds, criado por my_ics_token).
// Só título e hora (os privados como «Ocupado»), de 60 dias para trás a 180 para a frente. Sem verificação de JWT:
// a ligação é a chave (32 caracteres aleatórios; troca-se nas Definições → Office 365).
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const utc = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const day = (iso: string) => iso.slice(0, 10).replace(/-/g, '');
const fold = (l: string) => { const out: string[] = []; let x = l; while (x.length > 74) { out.push(x.slice(0, 74)); x = ' ' + x.slice(74); } out.push(x); return out.join('\r\n'); };

Deno.serve(async (req) => {
  const t = new URL(req.url).searchParams.get('t') ?? '';
  if (!/^[0-9a-f]{32}$/.test(t)) return new Response('Link inválido', { status: 404 });
  const { data: f } = await db.from('ics_feeds').select('member_id').eq('token', t).maybeSingle();
  if (!f) return new Response('Link inválido', { status: 404 });
  const from = new Date(Date.now() - 60 * 86_400_000).toISOString(), to = new Date(Date.now() + 180 * 86_400_000).toISOString();
  const { data: evs } = await db.from('ms_events').select('id, ical_uid, subject, start_at, end_at, all_day, is_private, show_as')
    .eq('member_id', f.member_id).gte('start_at', from).lte('start_at', to).order('start_at').limit(3000);
  const now = utc(new Date().toISOString());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NOVA Compass//Agenda//PT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:NOVA', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M'];
  for (const e of evs ?? []) {
    if (e.show_as === 'free' && !e.subject) continue;
    const title = e.is_private ? 'Ocupado' : (e.subject || 'Ocupado');
    lines.push('BEGIN:VEVENT', `UID:${e.ical_uid || e.id}`, `DTSTAMP:${now}`, `SUMMARY:${esc(title)}`);
    if (e.all_day) {
      const end = e.end_at ? day(e.end_at) : day(new Date(Date.parse(e.start_at) + 86_400_000).toISOString());
      lines.push(`DTSTART;VALUE=DATE:${day(e.start_at)}`, `DTEND;VALUE=DATE:${end}`);
    } else lines.push(`DTSTART:${utc(e.start_at)}`, `DTEND:${utc(e.end_at ?? new Date(Date.parse(e.start_at) + 3_600_000).toISOString())}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.map(fold).join('\r\n') + '\r\n', { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' } });
});
