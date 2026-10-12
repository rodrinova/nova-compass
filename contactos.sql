-- NOVA Compass — Contactos: fornecedores de materiais e serviços, especialidades, entidades (Câmara…)
-- Uma linha por empresa ou pessoa; "o que faz / fornece" em etiquetas livres para pesquisar e filtrar.
-- Seguro de correr mais do que uma vez.
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,                 -- empresa ou entidade (ou o nome da pessoa, se não houver empresa)
  person text,                        -- pessoa de contacto
  role text,                          -- cargo / função da pessoa
  phone text,
  phone2 text,
  email text,
  website text,
  location text,                      -- zona, concelho ou morada
  tags text[] not null default '{}',  -- o que fornece / faz (ex.: caixilharia, rebocos, AVAC, engenharia, Câmara)
  notes text,
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists contacts_tags_idx on public.contacts using gin (tags);

alter table public.contacts enable row level security;
drop policy if exists "team_only" on public.contacts;
create policy "team_only" on public.contacts for all to authenticated using (private.is_team_member()) with check (private.is_team_member());
