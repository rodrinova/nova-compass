-- NOVA Compass — o calendário do Outlook de cada pessoa sem o Office 365 ligado: o link «Publicar calendário» (ICS)
-- do Outlook, colado pela própria pessoa. Junta-se à agenda que sai pelo link secreto (função agenda-ics).
-- Só o servidor lê o link (é secreto); a pessoa grava-o ou apaga-o pela função set_my_outlook_ics.
create table if not exists public.outlook_feeds (
  member_id uuid primary key references public.team_members(id) on delete cascade,
  url text not null check (url ~* '^https://'),
  updated_at timestamptz not null default now()
);
alter table public.outlook_feeds enable row level security;
revoke all on public.outlook_feeds from anon, authenticated;

create or replace function public.set_my_outlook_ics(link text) returns boolean
language plpgsql security definer set search_path = public as $$
declare m uuid; u text := nullif(trim(coalesce(link, '')), '');
begin
  select id into m from public.team_members where active and lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) limit 1;
  if m is null then raise exception 'só para a equipa'; end if;
  if u is null then delete from public.outlook_feeds where member_id = m; return false; end if;
  u := regexp_replace(u, '^webcals?://', 'https://', 'i');
  if u !~* '^https://[^/]+\.(office365\.com|outlook\.com|office\.com|live\.com)/' then raise exception 'Isto não parece um link de calendário do Outlook (.ics).'; end if;
  insert into public.outlook_feeds (member_id, url, updated_at) values (m, u, now())
    on conflict (member_id) do update set url = excluded.url, updated_at = now();
  return true;
end $$;
revoke all on function public.set_my_outlook_ics(text) from public, anon;
grant execute on function public.set_my_outlook_ics(text) to authenticated;

-- Se a pessoa já tem o link do Outlook posto (sem o mostrar).
create or replace function public.my_outlook_ics_set() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.outlook_feeds f join public.team_members t on t.id = f.member_id
                 where t.active and lower(t.email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
revoke all on function public.my_outlook_ics_set() from public, anon;
grant execute on function public.my_outlook_ics_set() to authenticated;
