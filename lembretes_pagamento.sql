-- NOVA Compass — Lembretes de pagamento automáticos (email ao cliente / PM)
-- Pronto pagamento: a fatura vence na data de emissão. Lembretes aos 15 e 30 dias (app_settings 'pay_reminders').
-- Seguro de correr mais do que uma vez.
alter table public.projects add column if not exists pay_reminder_to text not null default 'client' check (pay_reminder_to in ('client','pm','both'));
alter table public.invoices add column if not exists reminders_paused boolean not null default false;
create table if not exists public.invoice_reminders (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  step integer not null,                 -- dias depois da emissão (15, 30)
  status text not null default 'sent' check (status in ('sent', 'skipped', 'error')),
  sent_to text,
  owed numeric,
  error text,
  created_at timestamptz not null default now(),
  unique (invoice_id, step)
);
alter table public.invoice_reminders enable row level security;
drop policy if exists "Só a equipa" on public.invoice_reminders;
create policy "Só a equipa" on public.invoice_reminders for all to authenticated using (private.is_team_member()) with check (private.is_team_member());
revoke all on public.invoice_reminders from anon;
-- Regras (editáveis em Definições → Lembretes de pagamento). "from": só faturas emitidas a partir desta data.
insert into public.app_settings (key, value, updated_at) values ('pay_reminders', jsonb_build_object(
  'active', true, 'steps', jsonb_build_array(15, 30), 'from', to_char(now() at time zone 'Europe/Lisbon', 'YYYY-MM-DD'), 'iban', ''
), now()) on conflict (key) do nothing;
-- Correr todos os dias às 9:13 (UTC; ~10:13 em Lisboa no verão)
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin perform cron.unschedule('pay-reminders'); exception when others then null; end $$;
select cron.schedule('pay-reminders', '13 9 * * *', $cron$
  select net.http_post(
    url := 'https://syatogsavmrcgjcuydtu.supabase.co/functions/v1/pay-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5YXRvZ3Nhdm1yY2dqY3V5ZHR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMzc0NzEsImV4cCI6MjA5MDcxMzQ3MX0.Pcu3vfXKtbdqFWV0gv2b9ReHpwMErj40hbw_PgkFVBM'),
    body := '{"action":"tick"}'::jsonb)
$cron$);
