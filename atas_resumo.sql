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

-- Agendamento: 3 minutos depois de cada sincronização do Office 365 (que corre de 10 em 10 minutos), pede os resumos
-- que faltam. Usa o mesmo pedido do agendamento 'ms365-sync' (office365.sql), só com outro endereço e corpo.
do $$
declare c text;
begin
  select replace(replace(command, '/functions/v1/ms365-sync', '/functions/v1/meeting-ai'), $b$'{}'::jsonb$b$, $b$'{"pending":true}'::jsonb$b$)
    into c from cron.job where jobname = 'ms365-sync';
  if c is null then raise notice 'Corre primeiro office365.sql'; return; end if;
  perform cron.schedule('meeting-ai', '3-59/10 * * * *', c);
end $$;
