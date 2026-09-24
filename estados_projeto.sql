-- NOVA Compass — Estados de projeto: lista fixa, personalizável em Definições
--
-- projects.status continua a guardar um código estável (To Do, WIP, Done, …), que as
-- outras ferramentas já usam. Cada código tem um nome em português, cor e ordem,
-- editáveis em Definições. A regra fixa antiga (check) passa a chave estrangeira para
-- esta tabela: podem acrescentar-se estados, e continua impossível gravar um valor
-- inválido ou apagar um estado em uso. Não altera nenhum projeto.
-- Seguro de correr mais do que uma vez.

create table if not exists project_statuses (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,               -- valor guardado em projects.status
  name       text not null,                      -- nome mostrado na app
  color      text not null default '#714D79',
  sort_order integer not null default 0,
  is_closed  boolean not null default false,     -- "fechado": sai da lista de projetos ativos
  created_at timestamptz not null default now()
);

-- Os 5 estados que a base de dados já aceitava, com nome em português
insert into project_statuses (code, name, color, sort_order, is_closed) values
  ('To Do',        'Por iniciar',  '#5A6B7A', 1, false),
  ('For Approval', 'Em aprovação', '#3E6FA8', 2, false),
  ('WIP',          'Em curso',     '#714D79', 3, false),
  ('Interrupted',  'Interrompido', '#B8842A', 4, false),
  ('Done',         'Concluído',    '#2E7D4F', 5, true)
on conflict (code) do nothing;

-- A lista fixa antiga dá lugar à ligação à tabela de estados
alter table projects drop constraint if exists projects_status_check;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'projects_status_fkey') then
    alter table projects
      add constraint projects_status_fkey foreign key (status)
      references project_statuses(code) on update cascade;
  end if;
end $$;

-- Mesma regra do resto da base de dados: só membros ativos da equipa
alter table project_statuses enable row level security;
drop policy if exists "Só a equipa" on project_statuses;
create policy "Só a equipa" on project_statuses
  for all to authenticated
  using (private.is_team_member()) with check (private.is_team_member());
revoke all on project_statuses from anon;
