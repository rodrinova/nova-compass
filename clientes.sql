-- NOVA Compass — Repositório de clientes
--
-- Um cliente (pessoa ou organização) tem várias "entidades de faturação": a título pessoal
-- (com NIF pessoal) e/ou empresas (nome, NIF, morada fiscal). Cada projeto aponta para o
-- cliente e para a entidade usada nesse projeto.
-- Pesos do score de clientes guardados em app_settings (editáveis em Definições).
-- Os projetos com o cliente só em texto passam a estar ligados a um cliente (criado se preciso).
-- Mesma regra de acesso do resto: só membros ativos da equipa. Seguro de correr mais do que uma vez.

create table if not exists client_entities (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  kind       text not null default 'personal' check (kind in ('personal', 'company')),
  name       text,            -- nome da empresa (vazio = a título pessoal, usa o nome do cliente)
  nif        text,
  address    text,            -- morada fiscal
  notes      text,
  created_at timestamptz not null default now(),
  check (kind = 'personal' or length(trim(coalesce(name, ''))) > 0)
);
create index if not exists client_entities_client_idx on client_entities(client_id);

alter table projects add column if not exists client_entity_id uuid references client_entities(id) on delete set null;

-- Definições da app (chave → valor)
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
insert into app_settings (key, value)
values ('client_score_weights', '{"recurrence": 25, "projects": 25, "invoiced": 25, "rate": 25}')
on conflict (key) do nothing;

-- Projetos com o cliente só em texto → cliente (criado se ainda não existir) e ligação
insert into clients (name)
select distinct on (lower(trim(p.client))) trim(p.client)
from projects p
where p.client_id is null and length(trim(coalesce(p.client, ''))) > 0
  and not exists (select 1 from clients c where lower(c.name) = lower(trim(p.client)));

update projects p set client_id = c.id
from clients c
where p.client_id is null and lower(c.name) = lower(trim(p.client));

-- Nomes que são claramente empresas (Lda, S.A., Unipessoal) ganham já a entidade "empresa"
insert into client_entities (client_id, kind, name)
select c.id, 'company', c.name
from clients c
where c.name ~* '(\mlda\M|\munipessoal\M|\ms\.?a\.?$)'
  and not exists (select 1 from client_entities e where e.client_id = c.id);

update projects p set client_entity_id = e.id
from client_entities e
where p.client_entity_id is null and e.client_id = p.client_id and e.kind = 'company'
  and (select count(*) from client_entities e2 where e2.client_id = p.client_id) = 1;

-- Acesso: só a equipa
do $$
declare t text;
begin
  foreach t in array array['client_entities', 'app_settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "Só a equipa" on %I', t);
    execute format('create policy "Só a equipa" on %I for all to authenticated using (private.is_team_member()) with check (private.is_team_member())', t);
    execute format('revoke all on %I from anon', t);
  end loop;
end $$;
