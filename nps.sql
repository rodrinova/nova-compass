-- NOVA Compass — NPS (satisfação do cliente), fase a fase
-- Seguro de correr mais do que uma vez.
--
-- Como funciona:
--  * A função "nps-dispatch" (Edge Function, corre de hora a hora) vê as fases entregues ao cliente,
--    cria um pedido por fase elegível (nps_requests) e envia o email X dias depois da entrega.
--  * O cliente responde numa página pública (nps.html) que só fala com a base de dados através
--    das três funções abaixo, identificadas por um código secreto por pedido (token).
--  * Regras (tipos de fase, dias, limites) em app_settings 'nps', editáveis em Definições.

-- 1. Clientes: língua dos emails e "não quero receber inquéritos"
alter table public.clients add column if not exists language text not null default 'pt';
alter table public.clients add column if not exists nps_opt_out boolean not null default false;
do $$ begin
  alter table public.clients add constraint clients_language_chk check (language in ('pt', 'en'));
exception when duplicate_object then null; end $$;

-- 2. Pedidos de NPS (um por fase entregue, ou um no fecho do projeto)
create table if not exists public.nps_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  stage_id uuid references public.project_stages(id) on delete cascade,
  kind text not null default 'fase' check (kind in ('fase', 'revisao', 'fecho')),
  phase_name text,                       -- tipo de fase no momento do pedido (para análise por fase)
  client_id uuid references public.clients(id) on delete set null,
  owner_id uuid,                         -- responsável do projeto no momento do pedido
  token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  status text not null default 'scheduled' check (status in ('scheduled', 'sent', 'answered', 'skipped', 'expired')),
  skip_reason text,                      -- cooldown | opt_out | manual | before_launch
  scheduled_for date not null,
  sent_to text,
  sent_at timestamptz,
  reminder_sent_at timestamptz,
  answered_at timestamptz,
  score smallint check (score between 0 and 10),
  comment text,
  followup_done_at timestamptz,
  followup_note text,
  send_error text,
  source text not null default 'auto' check (source in ('auto', 'excel')),   -- excel = respostas do formulário antigo
  created_at timestamptz not null default now()
);
alter table public.nps_requests add column if not exists source text not null default 'auto';
create unique index if not exists nps_requests_stage_uq on public.nps_requests(stage_id) where stage_id is not null;
create unique index if not exists nps_requests_close_uq on public.nps_requests(project_id) where kind = 'fecho';
create index if not exists nps_requests_client_idx on public.nps_requests(client_id);
create index if not exists nps_requests_project_idx on public.nps_requests(project_id);

alter table public.nps_requests enable row level security;
drop policy if exists "Só a equipa" on public.nps_requests;
create policy "Só a equipa" on public.nps_requests for all to authenticated
  using (private.is_team_member()) with check (private.is_team_member());
revoke all on public.nps_requests from anon;

-- 3. Página pública: só estas funções, e só com o token certo
create or replace function public.nps_form(p_token text) returns json
language plpgsql stable security definer set search_path = public as $$
declare r record;
begin
  select q.status, q.score, q.kind, q.phase_name, p.name as project, coalesce(c.language, 'pt') as lang
    into r
    from nps_requests q join projects p on p.id = q.project_id left join clients c on c.id = q.client_id
   where q.token = p_token;
  if not found then return json_build_object('ok', false); end if;
  return json_build_object('ok', true, 'answered', r.status = 'answered', 'score', r.score,
    'kind', r.kind, 'phase', r.phase_name, 'project', r.project, 'lang', r.lang);
end $$;

create or replace function public.nps_submit(p_token text, p_score int, p_comment text) returns json
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_score is null or p_score < 0 or p_score > 10 then return json_build_object('ok', false, 'error', 'score'); end if;
  update nps_requests
     set status = 'answered', score = p_score, answered_at = now(),
         comment = nullif(left(btrim(coalesce(p_comment, '')), 2000), '')
   where token = p_token and status <> 'answered';
  get diagnostics n = row_count;
  return json_build_object('ok', n = 1);
end $$;

create or replace function public.nps_opt_out(p_token text) returns json
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  select client_id into cid from nps_requests where token = p_token;
  if cid is null then return json_build_object('ok', false); end if;
  update clients set nps_opt_out = true where id = cid;
  update nps_requests set status = 'skipped', skip_reason = 'opt_out'
   where client_id = cid and status = 'scheduled';
  return json_build_object('ok', true);
end $$;

revoke all on function public.nps_form(text) from public;
revoke all on function public.nps_submit(text, int, text) from public;
revoke all on function public.nps_opt_out(text) from public;
grant execute on function public.nps_form(text) to anon, authenticated;
grant execute on function public.nps_submit(text, int, text) to anon, authenticated;
grant execute on function public.nps_opt_out(text) to anon, authenticated;

-- 4. Projetos já concluídos antes do NPS não recebem inquérito de fecho
insert into public.nps_requests (project_id, kind, client_id, status, skip_reason, scheduled_for)
select p.id, 'fecho', p.client_id, 'skipped', 'before_launch', current_date
  from public.projects p
 where p.status = 'Done'
   and not exists (select 1 from public.nps_requests q where q.project_id = p.id and q.kind = 'fecho');

-- 5. Regras por omissão (editáveis em Definições → NPS)
insert into public.app_settings (key, value, updated_at) values ('nps', jsonb_build_object(
  'active', true,
  'from', to_char(current_date, 'YYYY-MM-DD'),
  'types', jsonb_build_array('Estudo Preliminar', 'Estudo Prévio', 'Licenciamento', 'Execução', 'Execução II'),
  'client_revisions', true,
  'closing', true,
  'delay_days', 3,
  'reminder_days', 5,
  'expire_days', 30,
  'cooldown_days', 60,
  'sender_name', 'NOVA Associates',
  'from_email', '',
  'reply_to', ''
), now()) on conflict (key) do nothing;

-- 6. Correr o envio de hora a hora (pg_cron + pg_net chamam a Edge Function)
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
  perform cron.unschedule('nps-dispatch');
exception when others then null; end $$;
select cron.schedule('nps-dispatch', '23 * * * *', $cron$
  select net.http_post(
    url := 'https://syatogsavmrcgjcuydtu.supabase.co/functions/v1/nps-dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5YXRvZ3Nhdm1yY2dqY3V5ZHR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMzc0NzEsImV4cCI6MjA5MDcxMzQ3MX0.Pcu3vfXKtbdqFWV0gv2b9ReHpwMErj40hbw_PgkFVBM'),
    body := '{"action":"tick"}'::jsonb)
$cron$);
