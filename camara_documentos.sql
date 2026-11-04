-- NOVA Compass — Documentos do processo camarário de cada projeto (separador Câmara): ofícios, informações,
-- memória descritiva, pareceres. Cada ofício pode ser analisado pela IA (função camara-ai) e dar origem a um
-- relatório para o cliente, editável antes de exportar. Os ficheiros ficam no bucket privado "camara-docs" (até 5 MB cada;
-- a app comprime antes de enviar). Seguro de correr mais do que uma vez. Não apaga nada.

create table if not exists public.municipal_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null default 'oficio' check (kind in ('oficio', 'informacao', 'memoria', 'parecer', 'outro')),
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
-- Análise pela IA (camara-ai) e relatório para o cliente
alter table public.municipal_documents add column if not exists analysis jsonb;
alter table public.municipal_documents add column if not exists analysis_status text;      -- a_correr | ok | erro
alter table public.municipal_documents add column if not exists analysis_error text;
alter table public.municipal_documents add column if not exists analysis_started_at timestamptz;
alter table public.municipal_documents add column if not exists analysis_at timestamptz;
alter table public.municipal_documents add column if not exists analysis_by uuid;
alter table public.municipal_documents add column if not exists analysis_model text;
alter table public.municipal_documents add column if not exists client_report jsonb;       -- editado pela equipa (sem versões)
alter table public.municipal_documents add column if not exists client_report_at timestamptz;
alter table public.municipal_documents add column if not exists gemini_uri text;           -- cópia no Google (48 h)
alter table public.municipal_documents add column if not exists gemini_expires timestamptz;
alter table public.municipal_documents drop constraint if exists municipal_documents_kind_check;
alter table public.municipal_documents add constraint municipal_documents_kind_check check (kind in ('oficio', 'informacao', 'memoria', 'parecer', 'outro'));

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
