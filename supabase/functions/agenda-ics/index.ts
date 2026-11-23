// A agenda de uma pessoa em .ics, para subscrever noutra app (ex.: a NIKKI): os marcos de que é responsável
// (milestone_owners; reuniões, entregas…), as ausências (férias e justificadas) e, com o Office 365 ligado, os
// eventos do Outlook/Teams: pelo link «Publicar calendário» que a pessoa colou (outlook_feeds, sem o Office 365
// ligado) ou, com o Office 365 ligado, pela ms365-sync (ms_events). GET /functions/v1/agenda-ics?t=<link secreto da pessoa> (public.ics_feeds, criado por my_ics_token).
// Só título e hora (os privados como «Ocupado»), de 60 dias para trás a 180 para a frente. Sem verificação de JWT:
// a ligação é a chave (32 caracteres aleatórios; troca-se nas Definições → Office 365).
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
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
  const fromD = from.slice(0, 10), toD = to.slice(0, 10);
  const [{ data: own }, { data: abs }] = await Promise.all([
    db.from('milestone_owners').select('project_milestones(id, title, event_date, all_day, start_time, end_time, location, projects(name))').eq('member_id', f.member_id),
    db.from('absences').select('id, kind, start_date, end_date').eq('member_id', f.member_id).gte('end_date', fromD).lte('start_date', toD),
  ]);
  const now = utc(new Date().toISOString());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NOVA Compass//Agenda//PT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:NOVA', 'X-WR-TIMEZONE:Europe/Lisbon', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Lisbon', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'TZNAME:WEST', 'DTSTART:19700329T010000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000', 'TZNAME:WET', 'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'];
  const ev = (uid: string, title: string, when: string[], loc?: string | null) => { lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${now}`, `SUMMARY:${esc(title)}`, ...when, ...(loc ? [`LOCATION:${esc(loc)}`] : []), 'END:VEVENT'); };
  const next = (d: string) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
  const local = (d: string, t: string) => `${d.replace(/-/g, '')}T${t.slice(0, 8).replace(/:/g, '').padEnd(6, '0')}`;
  // Marcos (hora de Lisboa, como na app).
  for (const r of (own ?? []) as { project_milestones: { id: string; title: string; event_date: string; all_day: boolean; start_time: string | null; end_time: string | null; location: string | null; projects: { name: string } | null } | null }[]) {
    const m = r.project_milestones;
    if (!m || m.event_date < fromD || m.event_date > toD) continue;
    const title = m.projects?.name ? `${m.title} · ${m.projects.name}` : m.title;
    if (m.all_day || !m.start_time) ev(`m-${m.id}@nova-compass`, title, [`DTSTART;VALUE=DATE:${day(m.event_date)}`, `DTEND;VALUE=DATE:${day(next(m.event_date))}`], m.location);
    else ev(`m-${m.id}@nova-compass`, title, [`DTSTART;TZID=Europe/Lisbon:${local(m.event_date, m.start_time)}`, `DTEND;TZID=Europe/Lisbon:${local(m.event_date, m.end_time ?? m.start_time)}`], m.location);
  }
  // Ausências: dias inteiros.
  for (const a of abs ?? []) ev(`a-${a.id}@nova-compass`, a.kind === 'vacation' ? 'Férias' : 'Ausência', [`DTSTART;VALUE=DATE:${day(a.start_date)}`, `DTEND;VALUE=DATE:${day(next(a.end_date ?? a.start_date))}`]);
  // Outlook/Teams (quando o Office 365 estiver ligado).
  for (const e of evs ?? []) {
    if (e.show_as === 'free' && !e.subject) continue;
    const title = e.is_private ? 'Ocupado' : (e.subject || 'Ocupado');
    if (e.all_day) {
      const end = e.end_at ? day(e.end_at) : day(new Date(Date.parse(e.start_at) + 86_400_000).toISOString());
      ev(e.ical_uid || e.id, title, [`DTSTART;VALUE=DATE:${day(e.start_at)}`, `DTEND;VALUE=DATE:${end}`]);
    } else ev(e.ical_uid || e.id, title, [`DTSTART:${utc(e.start_at)}`, `DTEND:${utc(e.end_at ?? new Date(Date.parse(e.start_at) + 3_600_000).toISOString())}`]);
  }
  // Outlook pelo link publicado (sem M365): passa cada evento só com o essencial (título, horas, repetições).
  const { data: ol } = await db.from('outlook_feeds').select('url').eq('member_id', f.member_id).maybeSingle();
  if (ol?.url && !(evs ?? []).length) {
    try {
      const r = await fetch(ol.url, { signal: AbortSignal.timeout(12_000), headers: { accept: 'text/calendar, */*' } });
      const txt = r.ok ? (await r.text()).replace(/\r?\n[ \t]/g, '') : '';
      if (/BEGIN:VCALENDAR/i.test(txt)) {
        const tzs = [...txt.matchAll(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE/g)].map((m) => m[0].split(/\r?\n/));
        const at = lines.indexOf('END:VTIMEZONE') + 1;
        lines.splice(at, 0, ...tzs.flat());
        const KEEP = /^(UID|DTSTART|DTEND|DURATION|RRULE|RDATE|EXDATE|RECURRENCE-ID|SUMMARY|STATUS|TRANSP)[;:]/i;
        for (const m of txt.matchAll(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)) {
          const props = m[0].split(/\r?\n/).filter(Boolean);
          const priv = props.some((l) => /^CLASS:(PRIVATE|CONFIDENTIAL)/i.test(l));
          if (props.some((l) => /^STATUS:CANCELLED/i.test(l))) continue;
          const start = props.find((l) => /^DTSTART/i.test(l));
          const rec = props.some((l) => /^RRULE/i.test(l));
          const dv = start?.split(':').pop()?.slice(0, 8) ?? '';
          if (!rec && dv && (dv < fromD.replace(/-/g, '') || dv > toD.replace(/-/g, ''))) continue;
          const body = props.filter((l) => KEEP.test(l)).map((l) => (/^SUMMARY/i.test(l) && priv ? 'SUMMARY:Ocupado' : /^UID/i.test(l) ? `UID:o-${l.slice(l.indexOf(':') + 1)}` : l));
          if (!body.some((l) => /^SUMMARY/i.test(l))) body.push('SUMMARY:Ocupado');
          lines.push('BEGIN:VEVENT', `DTSTAMP:${now}`, ...body, 'END:VEVENT');
        }
      }
    } catch { /* o Outlook não respondeu: fica o resto */ }
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.map(fold).join('\r\n') + '\r\n', { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' } });
});
