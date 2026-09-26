-- NOVA Compass — Saúde financeira: extratos bancários, objetivos anuais, IVA e IRC
--
-- 1) Extratos (PDF do banco, importados todos os meses): cada movimento fica guardado uma vez
--    (fingerprint), mesmo que o mesmo extrato seja importado duas vezes.
--    - Saídas → despesas (ligadas à despesa já registada à mão, se houver uma igual);
--      as que a app não consegue classificar ficam "por classificar" (needs_review).
--    - Entradas → recebimentos de faturas (bank_receipt_matches); em caso de dúvida a app
--      sugere e pede confirmação. A data do movimento dá o prazo real de recebimento.
--    - Regras aprendidas (bank_rules): "este descritivo é sempre desta categoria/projeto/fase".
-- 2) Objetivos anuais da empresa (company_goals).
-- 3) Categorias de despesa: IVA dedutível típico e se contam para o EBITDA.
-- 4) Definições (app_settings 'finance'): regime de IVA, IRC do ano anterior, retenções.
-- Mesma regra de acesso do resto: só membros ativos da equipa. Seguro de correr mais do que uma vez.

create table if not exists bank_statements (
  id              uuid primary key default gen_random_uuid(),
  bank            text,
  account         text,
  file_name       text,
  period_from     date,
  period_to       date,
  opening_balance numeric,
  closing_balance numeric,
  n_transactions  integer not null default 0,
  imported_by     uuid references team_members(id) on delete set null,
  imported_at     timestamptz not null default now()
);

create table if not exists bank_transactions (
  id           uuid primary key default gen_random_uuid(),
  statement_id uuid references bank_statements(id) on delete set null,
  account      text,
  date         date not null,
  value_date   date,
  description  text not null,
  amount       numeric not null,              -- positivo = entrada, negativo = saída
  balance      numeric,
  fingerprint  text not null unique,
  kind         text not null default 'unclassified'
               check (kind in ('unclassified', 'expense', 'receipt', 'tax', 'internal', 'ignored')),
  tax_type     text check (tax_type is null or tax_type in ('iva', 'irc', 'ss', 'irs', 'other')),
  reviewed     boolean not null default false, -- confirmado por uma pessoa
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists bank_transactions_date_idx on bank_transactions(date);

create table if not exists bank_receipt_matches (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references bank_transactions(id) on delete cascade,
  invoice_id     uuid not null references invoices(id) on delete cascade,
  amount         numeric not null,            -- parte do movimento que paga esta fatura (com IVA)
  confirmed      boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (transaction_id, invoice_id)
);
create index if not exists bank_receipt_matches_invoice_idx on bank_receipt_matches(invoice_id);

create table if not exists bank_rules (
  id          uuid primary key default gen_random_uuid(),
  pattern     text not null,                  -- texto do descritivo (sem maiúsculas/acentos)
  kind        text not null default 'expense' check (kind in ('expense', 'tax', 'internal', 'ignored')),
  tax_type    text,
  category_id uuid references expense_categories(id) on delete set null,
  project_id  uuid references projects(id) on delete set null,
  stage_id    uuid references project_stages(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (pattern)
);

alter table expenses add column if not exists stage_id uuid references project_stages(id) on delete set null;
alter table expenses add column if not exists bank_transaction_id uuid references bank_transactions(id) on delete set null;
alter table expenses add column if not exists needs_review boolean not null default false;
alter table expenses add column if not exists vat_amount numeric;   -- IVA da despesa, se se souber (senão estima-se pela categoria)

alter table expense_categories add column if not exists vat_rate numeric not null default 23 check (vat_rate >= 0 and vat_rate <= 100);
alter table expense_categories add column if not exists in_ebitda boolean not null default true;
alter table expense_categories add column if not exists is_payroll boolean not null default false;

-- Categorias novas para o que vem do banco; IVA típico das existentes (ajustável em Definições)
insert into expense_categories (name, vat_rate, is_payroll)
select v.name, v.vat, v.payroll from (values
  ('Pessoal', 0::numeric, true), ('Comissões bancárias', 0, false), ('Impostos e taxas', 0, false)
) v(name, vat, payroll)
where not exists (select 1 from expense_categories c where lower(c.name) = lower(v.name));
update expense_categories set vat_rate = 0
 where name in ('Refeições Internas', 'Despesas de Representação', 'Deslocações', 'Pessoal', 'Comissões bancárias', 'Impostos e taxas')
   and vat_rate = 23;

create table if not exists company_goals (
  id         uuid primary key default gen_random_uuid(),
  year       integer not null,
  metric     text not null,
  target     numeric,
  params     jsonb not null default '{}',     -- ex.: {"project_type_ids": [...]}
  updated_at timestamptz not null default now(),
  unique (year, metric)
);

insert into app_settings (key, value)
values ('finance', '{"vat_regime": "quarterly", "vat_rate": 23, "irc_prev": null, "irc_withholding": 0}')
on conflict (key) do nothing;

do $$
declare t text;
begin
  foreach t in array array['bank_statements', 'bank_transactions', 'bank_receipt_matches', 'bank_rules', 'company_goals'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "Só a equipa" on %I', t);
    execute format('create policy "Só a equipa" on %I for all to authenticated using (private.is_team_member()) with check (private.is_team_member())', t);
    execute format('revoke all on %I from anon', t);
  end loop;
end $$;

-- Associar qualquer movimento a um projeto e fase (ex.: recebimento sem fatura, imposto de um projeto)
alter table bank_transactions add column if not exists project_id uuid references projects(id) on delete set null;
alter table bank_transactions add column if not exists stage_id uuid references project_stages(id) on delete set null;
alter table bank_transactions drop constraint if exists bank_transactions_kind_check;
alter table bank_transactions add constraint bank_transactions_kind_check check (kind in ('unclassified', 'expense', 'receipt', 'project_income', 'tax', 'internal', 'ignored'));
