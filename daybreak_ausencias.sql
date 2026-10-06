-- NOVA Compass — Daybreak (reunião diária das 8:40) e centro de ausências
-- Seguro de correr mais do que uma vez.

-- ---------- Daybreak: plano do dia (tarefas) ----------
-- Uma linha por tarefa e por dia. O que fica por fazer passa para o dia seguinte numa linha nova
-- (carried_from aponta para a anterior; carry_count conta os dias que já se arrasta). Assim o plano
-- de cada dia fica guardado tal como foi (planeado vs. feito).
-- As ações de melhoria decididas na reunião são tarefas com is_action e prazo (due_date).
create table if not exists public.daybreak_tasks (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.team_members(id) on delete cascade,
  day date not null,
  title text not null,
  priority boolean not null default false,
  done boolean not null default false,
  done_at timestamptz,
  carried boolean not null default false,          -- passou para o dia seguinte
  carried_from uuid references public.daybreak_tasks(id) on delete set null,
  carry_count integer not null default 0,
  checklist_item_id uuid references public.stage_checklist_items(id) on delete set null,
  stage_id uuid references public.project_stages(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  is_action boolean not null default false,
  due_date date,
  cause text,                                      -- causa que deu origem à ação
  sort_order integer not null default 0,
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists daybreak_tasks_member_day_idx on public.daybreak_tasks(member_id, day);
create index if not exists daybreak_tasks_day_idx on public.daybreak_tasks(day);

-- ---------- Daybreak: fecho do dia de cada pessoa ----------
create table if not exists public.daybreak_days (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.team_members(id) on delete cascade,
  day date not null,
  closed_at timestamptz,
  unplanned_h numeric not null default 0,
  unplanned_cause text,
  unplanned_note text,
  unplanned_project_id uuid references public.projects(id) on delete set null,
  rework_h numeric not null default 0,
  rework_cause text,
  rework_note text,
  rework_project_id uuid references public.projects(id) on delete set null,
  rework_stage_id uuid references public.project_stages(id) on delete set null,
  rework_auto numeric,                             -- horas que a app preencheu sozinha (fases "sempre retrabalho")
  plan_ready_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (member_id, day)
);

-- Fase que é toda retrabalho: as horas registadas nela contam sozinhas no fecho do dia.
-- null = ainda não se perguntou; true/false = resposta.
alter table public.project_stages add column if not exists always_rework boolean;

-- ---------- Ausências ----------
create table if not exists public.absences (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.team_members(id) on delete cascade,
  kind text not null check (kind in ('vacation', 'sick', 'justified', 'training')),
  subkind text,                                    -- ex.: consulta, casamento, falecimento, exame, formação…
  start_date date not null,
  end_date date not null,
  note text,
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists absences_dates_idx on public.absences(start_date, end_date);

-- Data de admissão (direito a férias no ano de entrada: 2 dias úteis por mês completo, até 20)
alter table public.team_members add column if not exists admission_date date;

alter table public.daybreak_tasks enable row level security;
alter table public.daybreak_days enable row level security;
alter table public.absences enable row level security;
drop policy if exists "Só a equipa" on public.daybreak_tasks;
drop policy if exists "Só a equipa" on public.daybreak_days;
drop policy if exists "Só a equipa" on public.absences;
create policy "Só a equipa" on public.daybreak_tasks for all to authenticated using (private.is_team_member()) with check (private.is_team_member());
create policy "Só a equipa" on public.daybreak_days for all to authenticated using (private.is_team_member()) with check (private.is_team_member());
create policy "Só a equipa" on public.absences for all to authenticated using (private.is_team_member()) with check (private.is_team_member());
revoke all on public.daybreak_tasks, public.daybreak_days, public.absences from anon;
-- Uma tarefa só passa uma vez para o dia seguinte (evita duplicados quando duas pessoas abrem a app ao mesmo tempo)
create unique index if not exists daybreak_tasks_carried_from_uidx on public.daybreak_tasks(carried_from);
