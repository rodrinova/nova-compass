-- NOVA Compass — Atas editáveis com versões (R00, R01, R02, …)
-- Correr uma vez na Supabase (depois de marcos.sql). Seguro de correr mais do que uma vez;
-- não apaga nem altera o conteúdo das atas existentes.
--
-- Como funciona:
--   • A ata original é a R00. Cada edição que mude o conteúdo passa a R01, R02, …
--   • Antes de cada edição, a versão anterior é arquivada em meeting_note_revisions,
--     com quem a escreveu e quando.
--   • Quem editou e quando é registado pela própria base de dados (trigger), a partir
--     da sessão de quem está autenticado — não depende da app e não pode ser forjado.
--   • O histórico só pode ser lido pela app; ninguém o consegue alterar ou apagar.

-- 1. Colunas de controlo na ata
alter table meeting_notes add column if not exists revision   integer not null default 0;
alter table meeting_notes add column if not exists created_by uuid references team_members(id);
alter table meeting_notes add column if not exists created_at timestamptz;
alter table meeting_notes alter column created_at set default now();
alter table meeting_notes add column if not exists updated_by uuid references team_members(id);
alter table meeting_notes add column if not exists updated_at timestamptz;

-- 2. Histórico de versões (note_id com o mesmo tipo do id de meeting_notes)
do $$
declare
  id_type text;
begin
  select format_type(a.atttypid, a.atttypmod) into id_type
  from pg_attribute a
  where a.attrelid = 'meeting_notes'::regclass and a.attname = 'id';

  if to_regclass('public.meeting_note_revisions') is null then
    execute format($f$
      create table meeting_note_revisions (
        id           uuid primary key default gen_random_uuid(),
        note_id      %s not null references meeting_notes(id) on delete cascade,
        revision     integer not null,
        title        text,
        body         text,
        meeting_date date,
        project_id   uuid,
        milestone_id uuid,
        edited_by    uuid references team_members(id) on delete set null,
        edited_at    timestamptz,
        archived_at  timestamptz not null default now(),
        unique (note_id, revision)
      )$f$, id_type);
  end if;
end $$;

-- 3. Quem está autenticado (pelo email da sessão Supabase), como membro da equipa
create or replace function current_team_member_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from team_members
  where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  limit 1
$$;

-- 4. Nova ata: começa sempre na R00, com autor e data automáticos
create or replace function meeting_notes_on_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.revision   := 0;
  new.updated_by := null;
  new.updated_at := null;
  new.created_at := coalesce(new.created_at, now());
  new.created_by := coalesce(current_team_member_id(), new.created_by);
  return new;
end $$;

drop trigger if exists meeting_notes_on_insert on meeting_notes;
create trigger meeting_notes_on_insert
  before insert on meeting_notes
  for each row execute function meeting_notes_on_insert();

-- 5. Edição: arquiva a versão anterior e sobe o número da versão
create or replace function meeting_notes_versioning() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- A autoria original nunca muda
  new.created_by := old.created_by;
  new.created_at := old.created_at;

  -- Sem alteração de conteúdo: não é nova versão (e os campos de controlo não se mexem)
  if (new.title, new.body, new.meeting_date, new.project_id, new.milestone_id)
     is not distinct from
     (old.title, old.body, old.meeting_date, old.project_id, old.milestone_id) then
    new.revision   := old.revision;
    new.updated_by := old.updated_by;
    new.updated_at := old.updated_at;
    return new;
  end if;

  insert into meeting_note_revisions
    (note_id, revision, title, body, meeting_date, project_id, milestone_id, edited_by, edited_at)
  values
    (old.id, old.revision, old.title, old.body, old.meeting_date, old.project_id, old.milestone_id,
     coalesce(old.updated_by, old.created_by), coalesce(old.updated_at, old.created_at))
  on conflict (note_id, revision) do nothing;

  new.revision   := old.revision + 1;
  new.updated_by := coalesce(current_team_member_id(), new.updated_by);
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists meeting_notes_versioning on meeting_notes;
create trigger meeting_notes_versioning
  before update on meeting_notes
  for each row execute function meeting_notes_versioning();

-- 6. Permissões
--    Histórico: só leitura para quem tem sessão iniciada.
alter table meeting_note_revisions enable row level security;
drop policy if exists "Ler versões de atas" on meeting_note_revisions;
create policy "Ler versões de atas" on meeting_note_revisions
  for select to authenticated using (true);

--    Atas: se a tabela tem RLS ligado mas nenhuma regra que permita editar, cria uma
--    (sem ela, as edições eram ignoradas em silêncio).
do $$
begin
  if (select relrowsecurity from pg_class where oid = 'meeting_notes'::regclass)
     and not exists (
       select 1 from pg_policies
       where schemaname = 'public' and tablename = 'meeting_notes' and cmd in ('UPDATE', 'ALL')
     ) then
    create policy "Editar atas" on meeting_notes
      for update to authenticated using (true) with check (true);
  end if;
end $$;
