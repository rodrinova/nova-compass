-- NOVA Compass — Melhorias: tickets da equipa (erros, melhorias, ideias), votos e comentários
-- Seguro de correr mais do que uma vez.
create table if not exists public.app_tickets (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'improvement' check (kind in ('bug', 'improvement', 'idea')),
  title text not null,
  body text,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'urgent')),
  status text not null default 'new' check (status in ('new', 'review', 'planned', 'done', 'rejected')),
  status_note text,
  status_changed_at timestamptz,
  author_seen boolean not null default true,   -- false quando o estado muda e o autor ainda não viu
  page text,                                   -- onde a pessoa estava (ex.: "Agenda")
  device text,                                 -- aparelho e largura do ecrã
  screenshot text,                             -- imagem reduzida (data URL), opcional
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists app_tickets_status_idx on public.app_tickets(status);

create table if not exists public.app_ticket_votes (
  ticket_id uuid not null references public.app_tickets(id) on delete cascade,
  member_id uuid not null references public.team_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (ticket_id, member_id)
);

create table if not exists public.app_ticket_comments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.app_tickets(id) on delete cascade,
  member_id uuid references public.team_members(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists app_ticket_comments_ticket_idx on public.app_ticket_comments(ticket_id);

alter table public.app_tickets enable row level security;
alter table public.app_ticket_votes enable row level security;
alter table public.app_ticket_comments enable row level security;
drop policy if exists "Só a equipa" on public.app_tickets;
drop policy if exists "Só a equipa" on public.app_ticket_votes;
drop policy if exists "Só a equipa" on public.app_ticket_comments;
create policy "Só a equipa" on public.app_tickets for all to authenticated using (private.is_team_member()) with check (private.is_team_member());
create policy "Só a equipa" on public.app_ticket_votes for all to authenticated using (private.is_team_member()) with check (private.is_team_member());
create policy "Só a equipa" on public.app_ticket_comments for all to authenticated using (private.is_team_member()) with check (private.is_team_member());
revoke all on public.app_tickets, public.app_ticket_votes, public.app_ticket_comments from anon;
