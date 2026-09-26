-- NOVA Compass — Reordenar as fases de um projeto (arrastar e largar na ficha do projeto)
--
-- Recebe a lista completa das fases do projeto pela nova ordem e grava stage_order = 1, 2, 3…
-- numa única instrução (ou grava tudo ou nada). Se a lista não corresponder exatamente às fases
-- atuais do projeto (ex.: alguém acrescentou uma fase entretanto), recusa e nada muda.
-- Corre com as permissões de quem chama: as regras "Só a equipa" continuam a aplicar-se.
-- Seguro de correr mais do que uma vez.

create or replace function public.reorder_project_stages(p_project_id uuid, p_stage_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  n_current integer;
  n_given   integer;
begin
  select count(*) into n_current from project_stages where project_id = p_project_id;
  select count(distinct x) into n_given from unnest(p_stage_ids) x;
  if n_given <> coalesce(cardinality(p_stage_ids), 0) or n_given <> n_current
     or exists (select 1 from unnest(p_stage_ids) x
                where not exists (select 1 from project_stages s where s.id = x and s.project_id = p_project_id)) then
    raise exception 'A lista de fases mudou entretanto. Recarrega o projeto e tenta outra vez.'
      using errcode = 'P0001';
  end if;

  update project_stages s
     set stage_order = x.ord
    from unnest(p_stage_ids) with ordinality as x(id, ord)
   where s.id = x.id and s.project_id = p_project_id and s.stage_order is distinct from x.ord;
end $$;

revoke all on function public.reorder_project_stages(uuid, uuid[]) from public, anon;
grant execute on function public.reorder_project_stages(uuid, uuid[]) to authenticated;
