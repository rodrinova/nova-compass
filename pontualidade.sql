-- NOVA Compass — Pontualidade: entradas, saídas e chegadas às reuniões
-- Seguro de correr mais do que uma vez.
--
--  * attendance: um registo por pessoa e por dia (escritório, fora — obra/Câmara/cliente — ou folga).
--    edited = a hora foi posta à mão (esqueci-me de marcar), fica assinalado no placar.
--  * meeting_checkins: "Estou cá" em cada reunião/visita (marcos com hora de que a pessoa faz parte).
--  * project_milestones.ended_at: quando a reunião acabou de facto ("Acabou"), para ver as que derrapam.
--  * Regras (horário, tolerância, minutos por copo, limite do jantar de deboche) em app_settings 'attendance', editáveis em Definições.

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.team_members(id) on delete cascade,
  day date not null,
  kind text not null default 'office' check (kind in ('office', 'out', 'off')),
  check_in timestamptz,
  check_out timestamptz,
  note text,
  edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (member_id, day)
);
create index if not exists attendance_day_idx on public.attendance(day);

create table if not exists public.meeting_checkins (
  milestone_id uuid not null references public.project_milestones(id) on delete cascade,
  member_id uuid not null references public.team_members(id) on delete cascade,
  arrived_at timestamptz not null default now(),
  edited boolean not null default false,
  primary key (milestone_id, member_id)
);

alter table public.project_milestones add column if not exists ended_at timestamptz;

alter table public.attendance enable row level security;
alter table public.meeting_checkins enable row level security;
drop policy if exists "Só a equipa" on public.attendance;
drop policy if exists "Só a equipa" on public.meeting_checkins;
create policy "Só a equipa" on public.attendance for all to authenticated
  using (private.is_team_member()) with check (private.is_team_member());
create policy "Só a equipa" on public.meeting_checkins for all to authenticated
  using (private.is_team_member()) with check (private.is_team_member());
revoke all on public.attendance, public.meeting_checkins from anon;

insert into public.app_settings (key, value, updated_at) values ('attendance', jsonb_build_object(
  'from', '2026-10-01',
  'start', '08:00',
  'end', '14:00',
  'tolerance', 5,
  'minutes_per_drink', 10,
  'dinner_minutes', 30,
  'members', '{}'::jsonb
), now()) on conflict (key) do nothing;
