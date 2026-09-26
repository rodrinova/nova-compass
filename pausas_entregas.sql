-- NOVA Compass — Pausas entre fases, responsável do projeto e marcos de entrega automáticos
--
-- 1) Pausas posicionadas entre fases: after_stage_id diz depois de que fase a pausa acontece.
--    As fases seguintes só começam a contar o lead time depois de a pausa acabar (aberta = hoje).
--    Cada fase pode ignorar as pausas (ignores_breaks) — o "override".
-- 2) Responsável do projeto (owner_id): recebe na Home o aviso das pausas abertas.
-- 3) Marcos de entrega: cada fase com data de entrega tem um marco "Entrega" ligado (stage_id),
--    criado/atualizado/apagado automaticamente quando a data muda. Preenche o histórico.
-- 4) reorder_project_plan: grava de uma vez a ordem das fases e a posição das pausas.
-- Mesma regra de acesso do resto: só membros ativos da equipa. Seguro de correr mais do que uma vez.

alter table project_breaks add column if not exists after_stage_id uuid references project_stages(id) on delete set null;
alter table project_stages add column if not exists ignores_breaks boolean not null default false;
alter table projects add column if not exists owner_id uuid references team_members(id) on delete set null;
alter table project_milestones add column if not exists stage_id uuid references project_stages(id) on delete cascade;
alter table project_milestones add column if not exists auto_kind text check (auto_kind is null or auto_kind in ('delivery'));
create unique index if not exists project_milestones_delivery_key on project_milestones(stage_id) where auto_kind = 'delivery';

-- Marco de entrega sincronizado com a data de entrega da fase
create schema if not exists private;
create or replace function private.sync_delivery_milestone()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  t_id uuid;
  nm   text;
begin
  if new.delivery_date is null then
    delete from project_milestones where stage_id = new.id and auto_kind = 'delivery';
    return new;
  end if;
  select id into t_id from milestone_types where name = 'Entrega' order by sort_order nulls last limit 1;
  select st.name into nm from stage_types st where st.id = new.stage_type_id;
  nm := 'Entrega · ' || coalesce(nm, 'Fase') || coalesce(' ' || nullif(new.revision_label, ''), '');
  insert into project_milestones (project_id, type_id, title, event_date, all_day, done, stage_id, auto_kind)
  values (new.project_id, t_id, nm, new.delivery_date, true, true, new.id, 'delivery')
  on conflict (stage_id) where auto_kind = 'delivery'
  do update set event_date = excluded.event_date, title = excluded.title, project_id = excluded.project_id;
  return new;
end $$;

drop trigger if exists project_stages_delivery_milestone on project_stages;
create trigger project_stages_delivery_milestone
  after insert or update of delivery_date, stage_type_id, revision_label on project_stages
  for each row execute function private.sync_delivery_milestone();

-- Histórico: marcos para as entregas já registadas
insert into project_milestones (project_id, type_id, title, event_date, all_day, done, stage_id, auto_kind)
select s.project_id,
       (select id from milestone_types where name = 'Entrega' order by sort_order nulls last limit 1),
       'Entrega · ' || coalesce(st.name, 'Fase') || coalesce(' ' || nullif(s.revision_label, ''), ''),
       s.delivery_date, true, true, s.id, 'delivery'
from project_stages s
left join stage_types st on st.id = s.stage_type_id
where s.delivery_date is not null
on conflict (stage_id) where auto_kind = 'delivery' do nothing;

-- Pausas existentes: ficam a seguir à última fase terminada antes do início da pausa
-- (entregue, ou concluída com fim/prazo até essa data); sem nenhuma, a seguir à primeira fase
update project_breaks b
set after_stage_id = coalesce(
  (select s.id from project_stages s
    where s.project_id = b.project_id
      and coalesce(s.delivery_date,
                   case when s.status in ('done', 'completed') then coalesce(s.end_date, s.deadline_override) end) <= b.start_date
    order by s.stage_order desc limit 1),
  (select s.id from project_stages s where s.project_id = b.project_id order by s.stage_order limit 1))
where b.after_stage_id is null and b.start_date is not null;

-- Ordem das fases + posição das pausas, numa só instrução por tabela (tudo ou nada)
create or replace function public.reorder_project_plan(p_project_id uuid, p_stage_ids uuid[], p_break_ids uuid[], p_break_after uuid[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform reorder_project_stages(p_project_id, p_stage_ids);
  if coalesce(cardinality(p_break_ids), 0) <> coalesce(cardinality(p_break_after), 0)
     or exists (select 1 from unnest(p_break_ids) x
                where not exists (select 1 from project_breaks b where b.id = x and b.project_id = p_project_id))
     or exists (select 1 from unnest(p_break_after) y
                where y is not null and not (y = any(p_stage_ids))) then
    raise exception 'A lista de pausas mudou entretanto. Recarrega o projeto e tenta outra vez.' using errcode = 'P0001';
  end if;
  update project_breaks b
     set after_stage_id = x.after_id
    from unnest(p_break_ids, p_break_after) as x(id, after_id)
   where b.id = x.id and b.project_id = p_project_id and b.after_stage_id is distinct from x.after_id;
end $$;
revoke all on function public.reorder_project_plan(uuid, uuid[], uuid[], uuid[]) from public, anon;
grant execute on function public.reorder_project_plan(uuid, uuid[], uuid[], uuid[]) to authenticated;
