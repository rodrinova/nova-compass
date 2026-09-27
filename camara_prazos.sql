-- NOVA Compass — Prazos camarários (RJUE; regime novo a partir de 1/10/2026)
--
-- Em cada fase:
--  - pip_kind: PIP simples ou qualificado (muda o prazo de decisão da Câmara)
--  - approval_date: data da decisão/aprovação da Câmara (PIP, arquitetura, especialidades);
--    a aprovação da arquitetura faz contar os 6 meses para entregar as especialidades
--  - revision_kind: numa revisão de licenciamento, se é resposta a ofício ou aditamento
--    por alterações de projeto; as respostas a ofício contam para o KPI de qualidade
--  - oficio_date / oficio_deadline / oficio_no_deadline: data do ofício e prazo para responder
-- Os prazos (dias, úteis/corridos, aviso) guardam-se em app_settings 'camara_deadlines'.
-- Seguro de correr mais do que uma vez. Não apaga nada.

alter table project_stages add column if not exists pip_kind text;
alter table project_stages add column if not exists approval_date date;
alter table project_stages add column if not exists revision_kind text;
alter table project_stages add column if not exists oficio_date date;
alter table project_stages add column if not exists oficio_deadline date;
alter table project_stages add column if not exists oficio_no_deadline boolean not null default false;

alter table project_stages drop constraint if exists project_stages_pip_kind_check;
alter table project_stages add constraint project_stages_pip_kind_check check (pip_kind is null or pip_kind in ('simples', 'qualificado'));
alter table project_stages drop constraint if exists project_stages_revision_kind_check;
alter table project_stages add constraint project_stages_revision_kind_check check (revision_kind is null or revision_kind in ('oficio', 'aditamento', 'novo'));

-- Prazos que dependem da NOVA (os da Câmara ficam informativos, sem avisos na Home):
--  - aviso_local_sent: data em que se enviou ao dono de obra o aviso a afixar no local (após a submissão)
--  - alvara_date: alvará levantado / taxas pagas (depois da licença deferida)
--  - works_deadline: fim do prazo de execução da obra (do alvará) — pedir prorrogação ou licença de utilização
alter table project_stages add column if not exists aviso_local_sent date;
alter table project_stages add column if not exists alvara_date date;
alter table project_stages add column if not exists works_deadline date;

-- revision_kind 'novo': numa revisão de PIP, um PIP novo (não é resposta a ofício)

-- Estado "Em apreciação" (status = 'review'): a fase foi entregue/submetida e espera por alguém.
--  - waiting_on: de quem se está à espera (Câmara, cliente ou outro)
alter table project_stages add column if not exists waiting_on text;
alter table project_stages drop constraint if exists project_stages_waiting_on_check;
alter table project_stages add constraint project_stages_waiting_on_check check (waiting_on is null or waiting_on in ('camara', 'cliente', 'outro'));
