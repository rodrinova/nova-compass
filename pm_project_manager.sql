-- NOVA Compass — Project manager do cliente (intermediário) por projeto
-- Registo de PMs por cliente (como as entidades/NIFs) e um PM por projeto. Seguro de correr mais do que uma vez.
create table if not exists public.client_pms (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null, company text, email text, phone text, notes text,
  created_at timestamptz not null default now()
);
create index if not exists client_pms_client_idx on public.client_pms(client_id);
alter table public.projects add column if not exists pm_id uuid references public.client_pms(id) on delete set null;
-- A quem vai o inquérito NPS do projeto: cliente, PM ou os dois
alter table public.projects add column if not exists nps_to text not null default 'client' check (nps_to in ('client','pm','both'));
alter table public.client_pms enable row level security;
drop policy if exists "Só a equipa" on public.client_pms;
create policy "Só a equipa" on public.client_pms for all to authenticated using (private.is_team_member()) with check (private.is_team_member());
revoke all on public.client_pms from anon;
