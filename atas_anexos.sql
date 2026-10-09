-- Atas: imagens e esquissos anexados (aparecem no fim do PDF da ata como Fig. 1, Fig. 2…)
-- Ficheiros no bucket privado "ata-files"; a tabela guarda a ordem e a legenda.

create table if not exists public.meeting_note_files (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.meeting_notes(id) on delete cascade,
  path text not null,
  name text,
  caption text,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid
);
create index if not exists meeting_note_files_note_idx on public.meeting_note_files(note_id, sort);

alter table public.meeting_note_files enable row level security;
drop policy if exists team_only on public.meeting_note_files;
create policy team_only on public.meeting_note_files for all to authenticated
  using (private.is_team_member()) with check (private.is_team_member());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ata-files', 'ata-files', false, 15728640, array['image/png','image/jpeg','image/webp','image/gif','image/heic','image/heif'])
on conflict (id) do nothing;

drop policy if exists "ata files read" on storage.objects;
drop policy if exists "ata files insert" on storage.objects;
drop policy if exists "ata files delete" on storage.objects;
create policy "ata files read" on storage.objects for select to authenticated
  using (bucket_id = 'ata-files' and private.is_team_member());
create policy "ata files insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'ata-files' and private.is_team_member());
create policy "ata files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'ata-files' and private.is_team_member());
