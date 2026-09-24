-- NOVA Compass — Proteção e privacidade total dos dados
-- Regra única em toda a base de dados: só membros ATIVOS da equipa (team_members.active)
-- com sessão iniciada leem ou escrevem. Visitantes anónimos não têm acesso a nada.
-- Seguro de correr mais do que uma vez.
--
-- Para dar ou tirar acesso a alguém: marcar/desmarcar team_members.active
-- (o email do membro tem de ser o mesmo da conta de login).

-- 1. "É membro ativo da equipa?" — num schema privado, que a API não expõe
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.is_team_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members
    where active and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
$$;
revoke all on function private.is_team_member() from public, anon;
grant execute on function private.is_team_member() to authenticated;

-- 2. Todas as tabelas: RLS ligado e uma só regra, "Só a equipa"
--    (as regras antigas — "qualquer sessão iniciada" — são substituídas)
do $$
declare
  t text;
  pol record;
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('alter table public.%I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    if t = 'meeting_note_revisions' then
      -- histórico das atas: só leitura (quem escreve é o trigger)
      execute format('create policy "Só a equipa (leitura)" on public.%I for select to authenticated using (private.is_team_member())', t);
    else
      execute format('create policy "Só a equipa" on public.%I for all to authenticated using (private.is_team_member()) with check (private.is_team_member())', t);
    end if;
  end loop;
end $$;

-- 3. Anónimos: sem permissões em nada do schema public, agora e no futuro
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;

-- 4. Vistas passam a respeitar as regras de quem consulta (antes usavam as do dono)
alter view public.v_cst_promoter_matches set (security_invoker = true);
alter view public.v_cst_dashboard        set (security_invoker = true);
alter view public.v_mqt_lines            set (security_invoker = true);

-- 5. Funções do CST com search_path fixo
alter function public.cst_update_updated_at()  set search_path = public;
alter function public.cst_generate_ref()       set search_path = public;
alter function public.cst_snapshot_benchmark() set search_path = public;
alter function public.cst_handle_bought()      set search_path = public;

-- 6. Ficheiros (bucket privado mqt-csv-uploads): também só a equipa
drop policy if exists "mqt csv read"   on storage.objects;
drop policy if exists "mqt csv insert" on storage.objects;
drop policy if exists "mqt csv delete" on storage.objects;
create policy "mqt csv read" on storage.objects for select to authenticated
  using (bucket_id = 'mqt-csv-uploads' and private.is_team_member());
create policy "mqt csv insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'mqt-csv-uploads' and private.is_team_member());
create policy "mqt csv delete" on storage.objects for delete to authenticated
  using (bucket_id = 'mqt-csv-uploads' and private.is_team_member());
