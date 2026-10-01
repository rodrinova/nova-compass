-- NOVA Compass — Oportunidades: terrenos, investidores e propostas de honorários
-- Seguro de correr mais do que uma vez. Não mexe nas tabelas antigas cst_* (ficam como estão).
--
--  * investors: investidores que conhecemos e o perfil de cada um (tipologias, frações, investimento,
--    zonas, se querem terreno com projeto aprovado). Opcionalmente ligados a um cliente.
--  * land_plots: terrenos que nos chegam (de clientes ou da nossa network), a análise (PDM, viabilidade)
--    e a etapa do funil: registado → em análise → apresentado → proposta → ganho / perdido / descartado.
--  * land_presentations: a que investidores apresentámos cada terreno e o que disseram.
--  * fee_proposals: propostas de honorários (por m², valor global ou por fração), com a estimativa de
--    horas, o custo, as especialidades subcontratadas e a divisão por fases. Quando é aceite, cria o projeto.
--  * app_settings 'proposals': custo/hora da NOVA, valor/hora objetivo e as especialidades-modelo por tipo.

create table if not exists public.investors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text,
  email text,
  phone text,
  client_id uuid references public.clients(id) on delete set null,
  project_type_ids uuid[] not null default '{}',
  fractions_min integer,
  fractions_max integer,
  invest_min numeric,
  invest_max numeric,
  zones text[] not null default '{}',
  approved_pref text not null default 'any' check (approved_pref in ('any', 'approved', 'not_approved')),
  notes text,
  active boolean not null default true,
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.land_plots (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'registered'
    check (status in ('registered', 'analysis', 'presented', 'proposal', 'won', 'lost', 'discarded')),
  origin text not null default 'network' check (origin in ('client', 'network')),
  client_id uuid references public.clients(id) on delete set null,
  source_name text,
  scout_id uuid references public.team_members(id) on delete set null,
  address text,
  municipality text,
  parish text,
  maps_url text,
  docs_url text,
  land_area numeric,
  asking_price numeric,
  project_type_id uuid references public.project_types(id) on delete set null,
  has_approved_project boolean not null default false,
  pdm_class text,
  pdm_index numeric,
  max_floors integer,
  buildable_area numeric,
  fractions_est integer,
  build_cost_m2 numeric,
  other_costs_pct numeric,
  sale_price_m2 numeric,
  sellable_ratio numeric,
  notes text,
  risks text,
  closed_reason text,
  project_id uuid references public.projects(id) on delete set null,
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists land_plots_status_idx on public.land_plots(status);

create table if not exists public.land_presentations (
  id uuid primary key default gen_random_uuid(),
  plot_id uuid not null references public.land_plots(id) on delete cascade,
  investor_id uuid not null references public.investors(id) on delete cascade,
  presented_on date not null default current_date,
  status text not null default 'presented' check (status in ('presented', 'interested', 'declined', 'proposal')),
  notes text,
  created_at timestamptz not null default now(),
  unique (plot_id, investor_id)
);

create table if not exists public.fee_proposals (
  id uuid primary key default gen_random_uuid(),
  ref text,
  title text not null,
  plot_id uuid references public.land_plots(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  investor_id uuid references public.investors(id) on delete set null,
  client_name text,
  project_type_id uuid references public.project_types(id) on delete set null,
  method text not null default 'm2' check (method in ('m2', 'global', 'fraction')),
  area numeric,
  fractions integer,
  unit_value numeric,
  total numeric,
  est_hours numeric,
  cost_per_hour numeric,
  target_rate numeric,
  specialties jsonb not null default '[]',
  phases jsonb not null default '[]',
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'declined')),
  language text not null default 'pt' check (language in ('pt', 'en')),
  valid_days integer not null default 30,
  sent_on date,
  decided_on date,
  notes text,
  project_id uuid references public.projects(id) on delete set null,
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.investors enable row level security;
alter table public.land_plots enable row level security;
alter table public.land_presentations enable row level security;
alter table public.fee_proposals enable row level security;
do $$ declare t text; begin
  foreach t in array array['investors', 'land_plots', 'land_presentations', 'fee_proposals'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'Só a equipa') then
      execute format('create policy "Só a equipa" on public.%I for all to authenticated using (private.is_team_member()) with check (private.is_team_member())', t);
    end if;
  end loop;
end $$;
revoke all on public.investors, public.land_plots, public.land_presentations, public.fee_proposals from anon;

-- Tipologias novas (as três que já existem ficam como estão)
insert into public.project_types (name, size_measure)
select v.name, v.measure from (values
  ('Reabilitação', 'area'), ('Turismo / Hotel', 'area'), ('Comercial', 'area'), ('Misto', 'area')
) as v(name, measure)
where not exists (select 1 from public.project_types t where t.name = v.name);

-- Objetivo: 150 €/h (valor por hora que as propostas usam como referência)
insert into public.company_goals (year, metric, target) values (2026, 'revenue_per_hour', 150)
on conflict (year, metric) do update set target = coalesce(public.company_goals.target, excluded.target);

-- Definições das propostas: custo/hora da NOVA (preencher em Definições) e especialidades-modelo.
-- Cada especialidade: nome, modo ('m2' = € por m² de construção, 'fixed' = valor fixo) e valor (0 = a preencher).
insert into public.app_settings (key, value, updated_at) values ('proposals', jsonb_build_object(
  'cost_per_hour', null,
  'target_rate', 150,
  'specialties', jsonb_build_object('default', jsonb_build_array(
    jsonb_build_object('name', 'Topografia', 'mode', 'fixed', 'value', 0),
    jsonb_build_object('name', 'Estruturas e fundações', 'mode', 'm2', 'value', 0),
    jsonb_build_object('name', 'Águas e esgotos', 'mode', 'm2', 'value', 0),
    jsonb_build_object('name', 'Eletricidade e telecomunicações (ITED)', 'mode', 'm2', 'value', 0),
    jsonb_build_object('name', 'Comportamento térmico e AVAC', 'mode', 'm2', 'value', 0),
    jsonb_build_object('name', 'Acústica', 'mode', 'm2', 'value', 0),
    jsonb_build_object('name', 'Gás', 'mode', 'fixed', 'value', 0),
    jsonb_build_object('name', 'Segurança contra incêndio', 'mode', 'm2', 'value', 0)
  ))
), now()) on conflict (key) do nothing;

-- Viabilidade do terreno (estudo para o investidor) e perfil mais rico do investidor (matchmaker)
alter table public.land_plots add column if not exists feasibility jsonb;
alter table public.investors
  add column if not exists strategy text not null default 'sale',
  add column if not exists min_roi numeric,
  add column if not exists min_yield numeric,
  add column if not exists segment text,
  add column if not exists tags text[] not null default '{}';

-- Um terreno pode ter mais do que uma tipologia de uso
alter table public.land_plots add column if not exists project_type_ids uuid[] not null default '{}';
update public.land_plots set project_type_ids = array[project_type_id] where project_type_id is not null and cardinality(project_type_ids) = 0;
