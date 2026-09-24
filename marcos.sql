-- NOVA Compass — Marcos (datas-chave de projeto) + Agenda
-- Seguro de correr mais do que uma vez. Não apaga nem altera nada do que já existe.

-- 1. Tipos de marco (geríveis em Definições)
create table if not exists milestone_types (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  color       text not null default '#714D79',
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- Tipos iniciais, só se a tabela estiver vazia
insert into milestone_types (name, color, sort_order)
select v.name, v.color, v.sort_order
from (values
  ('Reunião',  '#714D79', 1),
  ('Visita',   '#2E7D4F', 2),
  ('Vistoria', '#B8842A', 3),
  ('Entrega',  '#C4453D', 4),
  ('Prazo',    '#5A6B7A', 5)
) as v(name, color, sort_order)
where not exists (select 1 from milestone_types);

-- 2. Marcos
--    event_date/start_time/end_time separados (date + time, não timestamptz):
--    evita a conversão de fuso horário que já nos deu problemas noutros sítios.
--    project_id anulável: permite marcos internos sem projeto associado.
create table if not exists project_milestones (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references projects(id) on delete cascade,
  type_id     uuid references milestone_types(id),
  title       text not null,
  event_date  date not null,
  all_day     boolean not null default false,
  start_time  time,
  end_time    time,
  location    text,
  notes       text,
  done        boolean not null default false,
  created_by  uuid references team_members(id),
  created_at  timestamptz not null default now()
);

create index if not exists idx_milestones_date    on project_milestones(event_date);
create index if not exists idx_milestones_project on project_milestones(project_id);

-- 3. Owners — em que calendário o marco aparece
create table if not exists milestone_owners (
  milestone_id uuid not null references project_milestones(id) on delete cascade,
  member_id    uuid not null references team_members(id) on delete cascade,
  primary key (milestone_id, member_id)
);

create index if not exists idx_milestone_owners_member on milestone_owners(member_id);

-- 4. Atas — cria a tabela se ainda não existir, e liga-a aos marcos
create table if not exists meeting_notes (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references projects(id),
  title        text not null,
  body         text,
  meeting_date date not null default current_date,
  created_by   uuid references team_members(id),
  created_at   timestamptz not null default now()
);

alter table meeting_notes
  add column if not exists milestone_id uuid references project_milestones(id) on delete set null;

-- 5. Despesas — coluna de arquivo que ficou por correr
alter table expenses
  add column if not exists archived_at timestamptz;
