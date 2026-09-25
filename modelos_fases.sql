-- NOVA Compass — Modelos de fases por tipo de projeto e intervalo de dimensão
--
-- Cada tipo de projeto mede a dimensão em m² (área) ou em frações (multifamiliares) e tem
-- intervalos (ex.: até 150 m², 150–300 m², …). Para cada tipo × intervalo há um modelo de
-- fases: ordem, tipo de fase, lead time e work time (dias úteis) e % dos honorários.
-- Ao criar um projeto, a app cria as fases do modelo que corresponde ao tipo e à dimensão.
-- Os modelos começam como cópia do projeto real mais completo de cada tipo (ajustáveis).
-- Mesma regra de acesso do resto: só membros ativos da equipa. Seguro de correr mais do que uma vez.

alter table projects add column if not exists fractions integer check (fractions is null or fractions >= 0);
alter table project_stages add column if not exists work_time_days integer check (work_time_days is null or work_time_days >= 0);
alter table project_types add column if not exists size_measure text not null default 'area'
  check (size_measure in ('area', 'fractions'));
update project_types set size_measure = 'fractions' where name ilike '%multifamil%';

create table if not exists project_type_size_bands (
  id              uuid primary key default gen_random_uuid(),
  project_type_id uuid not null references project_types(id) on delete cascade,
  min_value       numeric not null default 0 check (min_value >= 0),
  max_value       numeric check (max_value is null or max_value > min_value),   -- vazio = sem limite
  created_at      timestamptz not null default now()
);
create index if not exists project_type_size_bands_type_idx on project_type_size_bands(project_type_id, min_value);

create table if not exists phase_templates (
  id            uuid primary key default gen_random_uuid(),
  band_id       uuid not null references project_type_size_bands(id) on delete cascade,
  stage_type_id uuid not null references stage_types(id) on delete cascade,
  sort_order    integer not null default 0,
  lead_days     integer check (lead_days is null or lead_days >= 0),
  work_days     integer check (work_days is null or work_days >= 0),
  percentage    numeric check (percentage is null or (percentage >= 0 and percentage <= 100)),
  created_at    timestamptz not null default now()
);
create index if not exists phase_templates_band_idx on phase_templates(band_id, sort_order);

-- Intervalos de partida (só para tipos que ainda não têm nenhum)
insert into project_type_size_bands (project_type_id, min_value, max_value)
select pt.id, b.lo, b.hi
from project_types pt
cross join lateral (
  select * from (values
    -- frações (multifamiliares)
    ('fractions', 0::numeric, 4::numeric), ('fractions', 4, 10), ('fractions', 10, 25), ('fractions', 25, null),
    -- m²: moradias
    ('single', 0, 150), ('single', 150, 300), ('single', 300, 600), ('single', 600, null),
    -- m²: restantes (promoção, estudos de capacidade…)
    ('other', 0, 1000), ('other', 1000, 3000), ('other', 3000, 10000), ('other', 10000, null)
  ) v(grp, lo, hi)
  where v.grp = case when pt.size_measure = 'fractions' then 'fractions'
                     when pt.name ilike '%single%' or pt.name ilike '%unifamil%' then 'single' else 'other' end
) b
where not exists (select 1 from project_type_size_bands x where x.project_type_id = pt.id);

-- Modelos de partida: em cada tipo, o projeto adjudicado mais recente com pelo menos 4 fases de
-- base e percentagens a somar 100%; copiado para todos os intervalos do tipo
with ref as (
  select distinct on (p.project_type_id) p.id as project_id, p.project_type_id
  from projects p
  where p.project_type_id is not null
    and (select count(*) from project_stages s where s.project_id = p.id and s.base_stage) >= 4
    and abs(coalesce((select sum(s.percentage) from project_stages s where s.project_id = p.id and s.base_stage), 0) - 100) < 0.5
  order by p.project_type_id, p.awarding_date desc nulls last
)
insert into phase_templates (band_id, stage_type_id, sort_order, lead_days, percentage)
select b.id, s.stage_type_id, row_number() over (partition by b.id order by s.stage_order),
       s.expected_lead_time_days, round(s.percentage, 2)
from ref
join project_type_size_bands b on b.project_type_id = ref.project_type_id
join project_stages s on s.project_id = ref.project_id and s.base_stage
where not exists (select 1 from phase_templates t where t.band_id = b.id);

-- Acesso: só a equipa
do $$
declare t text;
begin
  foreach t in array array['project_type_size_bands', 'phase_templates'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "Só a equipa" on %I', t);
    execute format('create policy "Só a equipa" on %I for all to authenticated using (private.is_team_member()) with check (private.is_team_member())', t);
    execute format('revoke all on %I from anon', t);
  end loop;
end $$;
