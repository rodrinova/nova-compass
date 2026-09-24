-- NOVA Compass — Regras de acesso (RLS) para Marcos e Atas
-- As tabelas foram criadas com RLS ligado mas sem nenhuma regra, o que bloqueava
-- a própria app (Agenda, Marcos e Atas não liam nem gravavam nada).
-- Mesmo padrão das restantes tabelas com RLS: acesso a quem tem sessão iniciada;
-- nenhum acesso anónimo. Seguro de correr mais do que uma vez.

do $$
declare
  t text;
begin
  foreach t in array array['meeting_notes', 'milestone_types', 'project_milestones', 'milestone_owners'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "Acesso da equipa" on %I', t);
    execute format('create policy "Acesso da equipa" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
