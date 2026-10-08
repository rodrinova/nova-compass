-- NOVA Compass — MQT Studio (mapa de quantidades e trabalhos a partir das tabelas do Revit)
-- Seguro de correr mais do que uma vez.
--
-- Biblioteca fixa: capítulo → elemento (keynote fixo, ex.: PRD01) → variantes (PRD01.A, .B, .C).
-- O Revit exporta as tabelas (.txt) com a coluna Keynote; a app soma por keynote e monta o MQT.
-- Convenção dos códigos: prefixo + i/e quando há interior/exterior (PAVi01, REVe01) + número; variante .A/.B/.C
-- (As tabelas antigas mqt_keynotes/mqt_lines/mqt_rubricas/… são de um protótipo e ficam como estão.)

create table if not exists public.mqt_chapters (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                       -- '05'
  name text not null,
  sort_order integer not null default 0
);

create table if not exists public.mqt_elements (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                       -- 'PRD01'
  chapter_code text not null references public.mqt_chapters(code) on update cascade,
  name text not null,
  unit text not null default 'm²',                 -- m², m³, m, un, vg, kg
  -- de onde vem a quantidade: coluna da tabela do Revit, à mão (manual) ou calculada a partir de outros elementos (derived)
  qty_source text not null default 'area' check (qty_source in ('area', 'volume', 'length', 'count', 'perimeter', 'opening', 'manual', 'derived')),
  text text not null default '',                   -- texto do artigo; {var} é substituído pela variante
  revit_category text,                             -- só indicação (Walls, Floors…)
  waste_pct numeric not null default 0,            -- perdas / quebras
  split_by_type boolean not null default false,    -- um artigo por tipo do Revit (ex.: janelas J1, J2…)
  derive_from text[] not null default '{}',        -- para 'derived': códigos (ou prefixos) de onde vem
  derive_field text,                               -- area | length | perimeter | count | volume
  derive_factor numeric not null default 1,
  active boolean not null default true,
  notes text,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.mqt_variants (
  id uuid primary key default gen_random_uuid(),
  element_code text not null references public.mqt_elements(code) on update cascade on delete cascade,
  letter text not null,                            -- 'A'
  label text not null,                             -- '25 cm'
  text text,                                       -- texto próprio (opcional; senão usa o do elemento com {var})
  sort_order integer not null default 0,
  unique (element_code, letter)
);

-- "Não te esqueças": elementos típicos e regras "se há X tem de haver Y"
create table if not exists public.mqt_checks (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('typical', 'rule')),
  name text not null,
  if_codes text[] not null default '{}',
  codes text[] not null default '{}',
  hint text,
  active boolean not null default true,
  sort_order integer not null default 0
);

-- Cada carregamento das tabelas é uma versão (para ver o que mudou)
create table if not exists public.mqt_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  version integer not null,
  label text,
  files jsonb not null default '[]',
  rows jsonb not null default '[]',                -- linhas normalizadas das tabelas
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, version)
);

-- Por projeto: quantidades à mão e o que "não se aplica"
create table if not exists public.mqt_project (
  project_id uuid primary key references public.projects(id) on delete cascade,
  manual jsonb not null default '{}',              -- { "EST01": {"": 1}, "CAN01.A": {"Bloco A": 42} }
  na jsonb not null default '{}',                  -- { "<check id>": "motivo" }
  specs jsonb not null default '{}',               -- campos do texto por projeto: { "PAVi01.A": {"marca": "Margres", "cor": "Light Grey"} }
  updated_at timestamptz not null default now()
);

-- Propostas dos empreiteiros → registo de preços datados
create table if not exists public.mqt_quotes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete set null,
  contractor text not null,
  quote_date date not null,
  total numeric,
  file_name text,
  notes text,
  excluded boolean not null default false,         -- fora das médias (ex.: proposta anormal)
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists public.mqt_prices (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.mqt_quotes(id) on delete cascade,
  keynote text not null,                           -- 'PRD01.B'
  unit text,
  unit_price numeric not null,
  qty numeric,
  description text,
  created_at timestamptz not null default now()
);
create index if not exists mqt_prices_keynote_idx on public.mqt_prices(keynote);
create index if not exists mqt_runs_project_idx on public.mqt_runs(project_id, version desc);

do $$ declare t text; begin
  foreach t in array array['mqt_chapters','mqt_elements','mqt_variants','mqt_checks','mqt_runs','mqt_project','mqt_quotes','mqt_prices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "team_only" on public.%I', t);
    execute format('create policy "team_only" on public.%I for all to authenticated using (private.is_team_member()) with check (private.is_team_member())', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- A biblioteca inicial (capítulos, elementos, variantes e verificações) está em mqt_biblioteca.json:
-- a app carrega-a sozinha na primeira vez que se abre o MQT Studio (ou em Biblioteca → Repor).

-- ---------- MQT por projeto: textos próprios e revisões ----------
-- texts: descritivos ajustados neste projeto { "PRD01": "texto do artigo", "PRD01.A": "texto do subartigo" }
alter table public.mqt_project add column if not exists texts jsonb not null default '{}';
alter table public.mqt_project add column if not exists created_at timestamptz not null default now();
alter table public.mqt_project add column if not exists created_by uuid references public.team_members(id) on delete set null;
-- Revisões emitidas (R00, R01…): fotografia fixa de cada bloco, numeração fixa dos artigos e contagens
create table if not exists public.mqt_revisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  rev integer not null,
  note text,
  blocks jsonb not null default '{}',              -- { "<bloco>": [linhas] }  ("*" quando não há blocos)
  numbering jsonb not null default '{}',           -- { "<bloco>": { ch: {}, art: {}, sub: {} } }
  counts jsonb not null default '{}',              -- { new, rev, del }
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, rev)
);
alter table public.mqt_revisions enable row level security;
drop policy if exists "team_only" on public.mqt_revisions;
create policy "team_only" on public.mqt_revisions for all to authenticated using (private.is_team_member()) with check (private.is_team_member());
revoke all on public.mqt_revisions from anon;
