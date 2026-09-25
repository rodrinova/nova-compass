-- NOVA Compass — Gestão de faturação (importação do SAF-T do weoInvoice)
--
-- As faturas continuam a ser emitidas no weoInvoice (certificado). A app importa o ficheiro
-- SAF-T (PT) exportado de lá: faturas, notas de crédito e recibos. Cada documento é
-- identificado pelo número completo (ex.: "FT 2026/18"), por isso importar o mesmo período
-- duas vezes não duplica nada. As faturas que não se conseguem ligar a um projeto ficam
-- sem projeto ("Por associar") até alguém as associar.
-- amount / amount_paid continuam sem IVA (como os valores das fases); o total com IVA fica
-- em gross_amount. Documentos anulados ficam com valor 0 e status 'cancelled'.
-- Mesma regra de acesso do resto: só membros ativos da equipa. Seguro de correr mais do que uma vez.

alter table invoices add column if not exists source        text not null default 'manual' check (source in ('manual', 'saft'));
alter table invoices add column if not exists external_ref  text;          -- n.º completo no weoInvoice, ex.: "FT 2026/18"
alter table invoices add column if not exists doc_type      text;          -- FT, FR, FS, NC, ND
alter table invoices add column if not exists customer_nif  text;
alter table invoices add column if not exists customer_name text;
alter table invoices add column if not exists gross_amount  numeric;       -- com IVA
alter table invoices add column if not exists description   text;          -- descrição das linhas
alter table invoices add column if not exists status        text not null default 'normal' check (status in ('normal', 'cancelled'));
alter table invoices add column if not exists imported_at   timestamptz;
create unique index if not exists invoices_external_ref_key on invoices(external_ref) where external_ref is not null;

-- Registo de cada importação (quem, quando, o quê)
create table if not exists invoice_imports (
  id          uuid primary key default gen_random_uuid(),
  file_name   text,
  period_from date,
  period_to   date,
  n_new       integer not null default 0,
  n_updated   integer not null default 0,
  n_payments  integer not null default 0,
  n_unmatched integer not null default 0,
  imported_by uuid references team_members(id) on delete set null,
  imported_at timestamptz not null default now()
);

alter table invoice_imports enable row level security;
drop policy if exists "Só a equipa" on invoice_imports;
create policy "Só a equipa" on invoice_imports for all to authenticated
  using (private.is_team_member()) with check (private.is_team_member());
revoke all on invoice_imports from anon;

-- Recibos (um registo por recibo × fatura paga). O valor pago de cada fatura importada é a soma
-- dos seus recibos — assim um recibo de 2026 que paga uma fatura de 2025 conta, seja qual for a
-- ordem em que os ficheiros SAF-T são importados, e importar duas vezes não soma a dobrar.
create table if not exists invoice_payments (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references invoices(id) on delete cascade,
  receipt_ref text not null,          -- ex.: "RG 2026/5"
  amount      numeric not null,       -- sem IVA
  paid_at     date,
  created_at  timestamptz not null default now(),
  unique (receipt_ref, invoice_id)
);
create index if not exists invoice_payments_invoice_idx on invoice_payments(invoice_id);
alter table invoice_payments enable row level security;
drop policy if exists "Só a equipa" on invoice_payments;
create policy "Só a equipa" on invoice_payments for all to authenticated
  using (private.is_team_member()) with check (private.is_team_member());
revoke all on invoice_payments from anon;
