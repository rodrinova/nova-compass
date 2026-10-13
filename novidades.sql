-- Novidades da app (janela ao abrir) e pedidos resolvidos com imagem e «Mostrar-me»
alter table app_tickets add column if not exists status_image text;
alter table app_tickets add column if not exists status_nav text;
create table if not exists app_news (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  image text,          -- ex.: assets/news/cartao.jpg
  nav text,            -- destino do «Mostrar-me» (ex.: brand:card, nav:pipeline)
  published_at timestamptz not null default now(),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists app_news_reads (
  member_id uuid primary key references team_members(id) on delete cascade,
  last_seen timestamptz not null default now()
);
alter table app_news enable row level security;
alter table app_news_reads enable row level security;
create policy team_only on app_news for all using (private.is_team_member()) with check (private.is_team_member());
create policy team_only on app_news_reads for all using (private.is_team_member()) with check (private.is_team_member());
grant select, insert, update, delete on app_news, app_news_reads to authenticated;
