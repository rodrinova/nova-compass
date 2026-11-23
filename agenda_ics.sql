-- NOVA Compass — a agenda de cada pessoa noutras apps (ex.: a NIKKI): um link secreto (.ics) por pessoa.
-- O link lê-se pela função agenda-ics (título e hora; os privados como «Ocupado»). Só o servidor lê esta tabela.
create table if not exists public.ics_feeds (
  member_id uuid primary key references public.team_members(id) on delete cascade,
  token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  created_at timestamptz not null default now()
);
alter table public.ics_feeds enable row level security;
revoke all on public.ics_feeds from anon, authenticated;

-- O link da própria pessoa (a da sessão); renew = true troca-o (o antigo deixa de servir).
create or replace function public.my_ics_token(renew boolean default false) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare m uuid; t text;
begin
  select id into m from public.team_members where active and lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) limit 1;
  if m is null then raise exception 'só para a equipa'; end if;
  if renew then delete from public.ics_feeds where member_id = m; end if;
  insert into public.ics_feeds (member_id) values (m) on conflict (member_id) do nothing;
  select token into t from public.ics_feeds where member_id = m;
  return t;
end $$;
revoke all on function public.my_ics_token(boolean) from public, anon;
grant execute on function public.my_ics_token(boolean) to authenticated;
