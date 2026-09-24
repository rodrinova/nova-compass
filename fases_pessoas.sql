-- NOVA Compass — Fases de projeto atribuídas a pessoas
-- Várias pessoas por fase. Cada pessoa vê as suas fases na Home e no calendário.
-- Seguro de correr mais do que uma vez.

create table if not exists stage_assignees (
  stage_id   uuid not null references project_stages(id) on delete cascade,
  member_id  uuid not null references team_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (stage_id, member_id)
);

create index if not exists idx_stage_assignees_member on stage_assignees(member_id);

-- Mesma regra do resto da base de dados: só membros ativos da equipa
alter table stage_assignees enable row level security;
drop policy if exists "Só a equipa" on stage_assignees;
create policy "Só a equipa" on stage_assignees
  for all to authenticated
  using (private.is_team_member()) with check (private.is_team_member());
revoke all on stage_assignees from anon;
