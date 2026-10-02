-- NOVA Compass — ligação ao Office 365 (calendários)
-- ms_events: o que está no calendário Outlook/Teams de cada pessoa (lido de 10 em 10 minutos pela função ms365-sync).
-- ms_event_links: os eventos que a app escreveu nesses calendários (marcos, reuniões, lembretes do NOVA Radar).
-- A escrita é só da função (service role); a equipa só lê.
create table if not exists public.ms_events (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.team_members(id) on delete cascade,
  ms_id text not null,
  ical_uid text,
  subject text,
  start_at timestamptz not null,
  end_at timestamptz,
  all_day boolean not null default false,
  location text,
  is_online boolean not null default false,
  join_url text,
  show_as text,
  is_private boolean not null default false,
  organizer text,
  web_link text,
  synced_at timestamptz not null default now(),
  unique (member_id, ms_id)
);
create index if not exists ms_events_start_idx on public.ms_events (start_at);

create table if not exists public.ms_event_links (
  member_id uuid not null references public.team_members(id) on delete cascade,
  source_key text not null,          -- 'm:<marco>' ou 'r:<apresentação>'
  ms_event_id text not null,
  ical_uid text,
  hash text,
  updated_at timestamptz not null default now(),
  primary key (member_id, source_key)
);

alter table public.ms_events enable row level security;
alter table public.ms_event_links enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'ms_events' and policyname = 'Só a equipa') then
    create policy "Só a equipa" on public.ms_events for select using (private.is_team_member());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'ms_event_links' and policyname = 'Só a equipa') then
    create policy "Só a equipa" on public.ms_event_links for select using (private.is_team_member());
  end if;
end $$;

-- De 10 em 10 minutos (usa a mesma chave pública que o nps-dispatch)
do $$ declare auth text; begin
  if exists (select 1 from cron.job where jobname = 'ms365-sync') then return; end if;
  select substring(command from 'Bearer ([A-Za-z0-9._-]+)') into auth from cron.job where jobname = 'nps-dispatch';
  perform cron.schedule('ms365-sync', '*/10 * * * *', format($c$select net.http_post(
    url := 'https://syatogsavmrcgjcuydtu.supabase.co/functions/v1/ms365-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer %s'),
    body := '{}'::jsonb)$c$, auth));
end $$;

-- Marcos: opção "link Teams" (reunião online) e o link guardado para abrir na app
alter table public.project_milestones add column if not exists teams_link boolean not null default false;
alter table public.ms_event_links add column if not exists join_url text;
