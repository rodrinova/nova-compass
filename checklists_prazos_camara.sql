-- NOVA Compass — Checklists das fases, prazos com alerta e dados da câmara
--
-- 1. Checklists: modelo por tipo de fase (Definições) + checklist de cada fase.
--    Cada fase nova recebe uma cópia do modelo do seu tipo (trigger); depois ajusta-se à mão.
-- 2. Prazos com alerta: tipos de marco "prazo" e "avisar X dias antes" em cada marco.
-- 3. Câmara: município, n.º de processo e plataforma no projeto; credenciais com a
--    palavra-passe cifrada no Supabase Vault (só se lê por função, e fica registado quem viu);
--    histórico da tramitação camarária.
-- Mesma regra de acesso do resto: só membros ativos da equipa. Seguro de correr mais do que uma vez.

-- ---------- 1. Checklists ----------
create table if not exists stage_type_checklist_items (
  id            uuid primary key default gen_random_uuid(),
  stage_type_id uuid not null references stage_types(id) on delete cascade,
  title         text not null check (length(trim(title)) > 0),
  kind          text not null default 'task' check (kind in ('task', 'deliverable')),
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists stage_type_checklist_items_type_idx on stage_type_checklist_items(stage_type_id, sort_order);

create table if not exists stage_checklist_items (
  id         uuid primary key default gen_random_uuid(),
  stage_id   uuid not null references project_stages(id) on delete cascade,
  title      text not null check (length(trim(title)) > 0),
  kind       text not null default 'task' check (kind in ('task', 'deliverable')),
  sort_order integer not null default 0,
  done       boolean not null default false,
  done_at    timestamptz,
  done_by    uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists stage_checklist_items_stage_idx on stage_checklist_items(stage_id, sort_order);

-- Fase nova → cópia da checklist-modelo do seu tipo
create or replace function private.copy_stage_checklist()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stage_checklist_items (stage_id, title, kind, sort_order)
  select new.id, t.title, t.kind, t.sort_order
  from public.stage_type_checklist_items t
  where t.stage_type_id = new.stage_type_id;
  return new;
end $$;
revoke all on function private.copy_stage_checklist() from public, anon, authenticated;
drop trigger if exists project_stages_copy_checklist on project_stages;
create trigger project_stages_copy_checklist after insert on project_stages
  for each row execute function private.copy_stage_checklist();

-- ---------- 2. Prazos com alerta ----------
alter table milestone_types add column if not exists is_deadline boolean not null default false;
update milestone_types set is_deadline = true where name = 'Prazo';
alter table project_milestones add column if not exists alert_days integer
  check (alert_days is null or alert_days between 0 and 730);

-- ---------- 3. Câmara ----------
alter table projects add column if not exists municipality text;
alter table projects add column if not exists municipal_process_code text;
alter table projects add column if not exists municipal_platform_url text;

-- Credenciais: utilizador visível à equipa; a palavra-passe fica no Vault (só o id aqui)
create table if not exists project_credentials (
  project_id uuid primary key references projects(id) on delete cascade,
  username   text,
  secret_id  uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid references team_members(id) on delete set null
);
create table if not exists credential_access_log (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  member_id  uuid references team_members(id) on delete set null,
  action     text not null check (action in ('view', 'update', 'clear')),
  at         timestamptz not null default now()
);
create index if not exists credential_access_log_project_idx on credential_access_log(project_id, at desc);

-- Guardar utilizador e (opcionalmente) palavra-passe. p_password null = manter a atual.
create or replace function public.set_project_credentials(p_project uuid, p_username text, p_password text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_secret uuid; v_member uuid;
begin
  if not private.is_team_member() then raise exception 'Sem acesso'; end if;
  v_member := public.current_team_member_id();
  select secret_id into v_secret from public.project_credentials where project_id = p_project;
  if p_password is not null and length(p_password) > 0 then
    if v_secret is null then
      v_secret := vault.create_secret(p_password, 'project-credential-' || p_project::text, 'Plataforma da câmara');
    else
      perform vault.update_secret(v_secret, p_password);
    end if;
  end if;
  insert into public.project_credentials (project_id, username, secret_id, updated_at, updated_by)
  values (p_project, nullif(trim(p_username), ''), v_secret, now(), v_member)
  on conflict (project_id) do update
    set username = excluded.username, secret_id = excluded.secret_id, updated_at = now(), updated_by = v_member;
  insert into public.credential_access_log (project_id, member_id, action) values (p_project, v_member, 'update');
end $$;

-- Ver a palavra-passe (fica registado quem viu e quando)
create or replace function public.reveal_project_password(p_project uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_secret uuid; v_value text;
begin
  if not private.is_team_member() then raise exception 'Sem acesso'; end if;
  select secret_id into v_secret from public.project_credentials where project_id = p_project;
  if v_secret is null then return null; end if;
  select decrypted_secret into v_value from vault.decrypted_secrets where id = v_secret;
  insert into public.credential_access_log (project_id, member_id, action)
  values (p_project, public.current_team_member_id(), 'view');
  return v_value;
end $$;

-- Apagar a palavra-passe
create or replace function public.clear_project_password(p_project uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_secret uuid;
begin
  if not private.is_team_member() then raise exception 'Sem acesso'; end if;
  select secret_id into v_secret from public.project_credentials where project_id = p_project;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
    update public.project_credentials set secret_id = null, updated_at = now(), updated_by = public.current_team_member_id()
      where project_id = p_project;
  end if;
  insert into public.credential_access_log (project_id, member_id, action)
  values (p_project, public.current_team_member_id(), 'clear');
end $$;

revoke all on function public.set_project_credentials(uuid, text, text) from public, anon;
revoke all on function public.reveal_project_password(uuid) from public, anon;
revoke all on function public.clear_project_password(uuid) from public, anon;
grant execute on function public.set_project_credentials(uuid, text, text) to authenticated;
grant execute on function public.reveal_project_password(uuid) to authenticated;
grant execute on function public.clear_project_password(uuid) to authenticated;

-- Histórico da tramitação camarária
create table if not exists municipal_followups (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  followup_date date not null default current_date,
  status        text not null check (length(trim(status)) > 0),
  notes         text,
  created_by    uuid references team_members(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists municipal_followups_project_idx on municipal_followups(project_id, followup_date desc);

-- ---------- Acesso: só a equipa ----------
do $$
declare t text;
begin
  foreach t in array array['stage_type_checklist_items', 'stage_checklist_items', 'project_credentials', 'municipal_followups'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "Só a equipa" on %I', t);
    execute format('create policy "Só a equipa" on %I for all to authenticated using (private.is_team_member()) with check (private.is_team_member())', t);
    execute format('revoke all on %I from anon', t);
  end loop;
end $$;
-- O registo de acessos só se lê (as escritas são feitas pelas funções acima)
alter table credential_access_log enable row level security;
drop policy if exists "Só a equipa lê" on credential_access_log;
create policy "Só a equipa lê" on credential_access_log for select to authenticated using (private.is_team_member());
revoke all on credential_access_log from anon;
revoke insert, update, delete on credential_access_log from authenticated;
-- As credenciais só se escrevem pela função set_project_credentials (a app só as lê)
revoke insert, update, delete on project_credentials from authenticated;
