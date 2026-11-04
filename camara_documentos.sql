-- NOVA Compass — Documentos da Câmara: histórico de ofícios e informações camarárias de cada projeto
-- (separador Câmara do projeto). Os ficheiros ficam no bucket privado "camara-docs" (até 5 MB cada;
-- a app comprime antes de enviar). Seguro de correr mais do que uma vez. Não apaga nada.

create table if not exists public.municipal_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null default 'oficio' check (kind in ('oficio', 'informacao', 'outro')),
  title text not null,
  ref_number text,                 -- n.º do ofício / da informação
  doc_date date,                   -- data do documento
  path text not null,              -- caminho no bucket camara-docs
  file_name text,                  -- nome original do ficheiro
  mime text,
  size_bytes bigint,               -- tamanho guardado (depois de comprimido)
  original_bytes bigint,           -- tamanho antes de comprimir
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists municipal_documents_project_idx on public.municipal_documents(project_id, doc_date desc);

alter table public.municipal_documents enable row level security;
drop policy if exists team_only on public.municipal_documents;
create policy team_only on public.municipal_documents for all to authenticated
  using (private.is_team_member()) with check (private.is_team_member());
revoke all on public.municipal_documents from anon;
grant select, insert, update, delete on public.municipal_documents to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('camara-docs', 'camara-docs', false, 5242880, array['application/pdf','image/jpeg','image/png','image/webp'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "camara docs read" on storage.objects;
drop policy if exists "camara docs insert" on storage.objects;
drop policy if exists "camara docs delete" on storage.objects;
create policy "camara docs read" on storage.objects for select to authenticated
  using (bucket_id = 'camara-docs' and private.is_team_member());
create policy "camara docs insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'camara-docs' and private.is_team_member());
create policy "camara docs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'camara-docs' and private.is_team_member());
