-- NOVA Compass — Agenda: cor de cada pessoa (vazia = cor automática da paleta da app)
alter table public.team_members add column if not exists color text;
