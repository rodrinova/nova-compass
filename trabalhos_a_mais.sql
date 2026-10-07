-- NOVA Compass — Trabalhos a mais (pedidos do cliente fora do âmbito)
-- Valor por horas (horas × taxa) ou fixo. O cliente aprova ou recusa num link (aprovacao.html), sem conta.
-- Ao aprovar, a base de dados cria logo uma fase "TA01 — …" a seguir à fase relacionada, com o valor
-- (entra na Faturação), o prazo adicional como lead time (as fases seguintes andam) e onde se registam horas.
-- Seguro de correr mais do que uma vez.
create table if not exists public.change_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  number integer not null,
  title text not null,
  description text,
  pricing text not null default 'fixed' check (pricing in ('hours', 'fixed')),
  est_hours numeric,
  rate numeric,
  value numeric not null default 0,
  extra_days integer not null default 0,
  stage_type_id uuid references public.stage_types(id) on delete set null,   -- tipo da fase a criar
  after_stage_id uuid references public.project_stages(id) on delete set null, -- entra a seguir a esta fase
  stage_id uuid references public.project_stages(id) on delete set null,       -- fase criada ao aprovar
  status text not null default 'draft' check (status in ('draft', 'sent', 'approved', 'rejected', 'cancelled')),
  token text not null unique default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  source text not null default 'manual' check (source in ('manual', 'revision', 'ata')),
  source_id uuid,
  sent_at timestamptz,
  viewed_at timestamptz,
  decided_at timestamptz,
  decided_by_name text,
  decision_note text,
  team_seen boolean not null default true,          -- false quando o cliente decide e a equipa ainda não viu
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);
create index if not exists change_orders_project_idx on public.change_orders(project_id);
alter table public.change_orders enable row level security;
drop policy if exists "Só a equipa" on public.change_orders;
create policy "Só a equipa" on public.change_orders for all to authenticated using (private.is_team_member()) with check (private.is_team_member());
revoke all on public.change_orders from anon;

-- Página pública: ler o pedido (marca que foi visto)
create or replace function public.co_form(p_token text) returns json
language plpgsql security definer set search_path = public as $fn$
declare r record;
begin
  select co.*, p.name as project, coalesce(c.language, 'pt') as lang, c.name as client
    into r
    from change_orders co join projects p on p.id = co.project_id left join clients c on c.id = p.client_id
   where co.token = p_token and co.status <> 'draft';
  if not found then return json_build_object('ok', false); end if;
  if r.viewed_at is null and r.status = 'sent' then update change_orders set viewed_at = now() where token = p_token; end if;
  return json_build_object('ok', true, 'status', r.status, 'number', r.number, 'title', r.title, 'description', r.description,
    'pricing', r.pricing, 'est_hours', r.est_hours, 'rate', r.rate, 'value', r.value, 'extra_days', r.extra_days,
    'project', r.project, 'client', r.client, 'lang', r.lang, 'decided_at', r.decided_at, 'decided_by', r.decided_by_name);
end $fn$;

-- Página pública: aprovar ou recusar. Ao aprovar, cria a fase no projeto.
create or replace function public.co_decide(p_token text, p_decision text, p_name text, p_note text) returns json
language plpgsql security definer set search_path = public as $fn$
declare co record; v_order integer; v_stage uuid;
begin
  if p_decision not in ('approved', 'rejected') then return json_build_object('ok', false, 'error', 'decision'); end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then return json_build_object('ok', false, 'error', 'name'); end if;
  select * into co from change_orders where token = p_token for update;
  if not found or co.status <> 'sent' then return json_build_object('ok', false, 'error', 'state'); end if;
  if p_decision = 'approved' and co.stage_type_id is not null then
    select coalesce((select stage_order from project_stages where id = co.after_stage_id),
                    (select max(stage_order) from project_stages where project_id = co.project_id), 0) into v_order;
    update project_stages set stage_order = stage_order + 1 where project_id = co.project_id and stage_order > v_order;
    insert into project_stages (project_id, stage_type_id, stage_order, revision_label, base_stage, pricing_type, fixed_value,
                                expected_lead_time_days, status, revision_cause)
    values (co.project_id, co.stage_type_id, v_order + 1, 'TA' || lpad(co.number::text, 2, '0') || ' — ' || left(co.title, 60), false,
            'fixed', co.value, nullif(co.extra_days, 0), 'pending', 'cliente')
    returning id into v_stage;
  end if;
  update change_orders set status = p_decision, decided_at = now(), decided_by_name = left(btrim(p_name), 120),
         decision_note = nullif(left(btrim(coalesce(p_note, '')), 1000), ''), stage_id = v_stage, team_seen = false, updated_at = now()
   where id = co.id;
  return json_build_object('ok', true);
end $fn$;

revoke all on function public.co_form(text) from public;
revoke all on function public.co_decide(text, text, text, text) from public;
grant execute on function public.co_form(text) to anon, authenticated;
grant execute on function public.co_decide(text, text, text, text) to anon, authenticated;
