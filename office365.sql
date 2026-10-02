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
-- Convidados de cada evento lido (para a reunião aparecer a todos os da equipa que estão nela)
alter table public.ms_events add column if not exists attendee_emails text[], add column if not exists organizer_email text;

-- Convidados de fora da equipa (cliente, contactos do projeto, qualquer email): recebem o convite do Outlook
create table if not exists public.project_contacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text,
  email text not null,
  role text,
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, email)
);
create table if not exists public.milestone_guests (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references public.project_milestones(id) on delete cascade,
  name text,
  email text not null,
  created_at timestamptz not null default now(),
  unique (milestone_id, email)
);
alter table public.project_contacts enable row level security;
alter table public.milestone_guests enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'project_contacts' and policyname = 'Só a equipa') then
    create policy "Só a equipa" on public.project_contacts for all to authenticated using (private.is_team_member()) with check (private.is_team_member());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'milestone_guests' and policyname = 'Só a equipa') then
    create policy "Só a equipa" on public.milestone_guests for all to authenticated using (private.is_team_member()) with check (private.is_team_member());
  end if;
end $$;

-- Transcrições das reuniões Teams: a sincronização lê-as e arquiva cada uma como ata do projeto (meeting_notes)
create table if not exists public.meeting_transcripts (
  ical_uid text primary key,
  subject text,
  start_at timestamptz,
  end_at timestamptz,
  organizer_id uuid references public.team_members(id) on delete set null,
  status text not null default 'waiting',   -- waiting | done | none (sem transcrição) | error
  note_id uuid references public.meeting_notes(id) on delete set null,
  attempts int not null default 0,
  error text,
  checked_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.meeting_transcripts enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'meeting_transcripts' and policyname = 'Só a equipa') then
    create policy "Só a equipa" on public.meeting_transcripts for select using (private.is_team_member());
  end if;
end $$;

-- Gravação e transcrição automáticas: reuniões Teams futuras da equipa em que a app já ligou "recordAutomatically"
create table if not exists public.ms_autorecord (
  ical_uid text primary key,
  subject text,
  start_at timestamptz,
  status text not null default 'ok',   -- ok | error
  error text,
  set_at timestamptz not null default now()
);
alter table public.ms_autorecord enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'ms_autorecord' and policyname = 'Só a equipa') then
    create policy "Só a equipa" on public.ms_autorecord for select using (private.is_team_member());
  end if;
end $$;
