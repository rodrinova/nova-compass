-- NOVA Compass — Resumo inteligente das reuniões (Gemini)
-- Correr uma vez na Supabase (depois de atas_versoes.sql e office365.sql). Seguro de correr mais do que uma vez.
--
-- Como funciona:
--   • Logo que o Office 365 arquiva a transcrição de uma reunião Teams, a função «meeting-ai» lê-a e escreve
--     o resumo: decisões, opções de projeto, caminhos de futuro e quem sugeriu, aprovou e concordou.
--   • O resumo fica na própria ata (coluna summary) e não cria uma nova versão da ata.
--   • A linha curta (summary.linha) aparece na Cronologia do projeto, por baixo da reunião.
--   • summary_status: a_correr → ok | erro | curta (transcrição sem conteúdo para resumir).
--     Com erro, a sincronização seguinte volta a tentar (até 3 vezes).

alter table meeting_notes add column if not exists summary        jsonb;
alter table meeting_notes add column if not exists summary_status text;
alter table meeting_notes add column if not exists summary_at     timestamptz;
alter table meeting_notes add column if not exists summary_tries  integer not null default 0;
