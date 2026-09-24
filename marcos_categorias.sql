-- NOVA Compass — Marcos associados a categorias de horas (ex.: Project Scouting)
-- Correr DEPOIS de marcos.sql. Seguro de correr mais do que uma vez; não apaga nada.
--
-- Um marco fica associado a UM de três: um projeto, uma categoria de horas, ou nada (interno).

-- 1. Coluna category_id, com o mesmo tipo do id de time_categories (uuid ou numérico)
do $$
declare
  id_type text;
begin
  select format_type(a.atttypid, a.atttypmod) into id_type
  from pg_attribute a
  where a.attrelid = 'time_categories'::regclass and a.attname = 'id';

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'project_milestones' and column_name = 'category_id'
  ) then
    execute format(
      'alter table project_milestones add column category_id %s references time_categories(id) on delete set null',
      id_type);
  end if;
end $$;

create index if not exists idx_milestones_category on project_milestones(category_id);

-- 2. Nunca projeto e categoria ao mesmo tempo
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'milestone_project_or_category') then
    alter table project_milestones
      add constraint milestone_project_or_category
      check (project_id is null or category_id is null);
  end if;
end $$;
