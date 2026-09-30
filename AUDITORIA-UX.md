# Auditoria UX — NOVA Compass

*30 de setembro de 2026 · `index.html` com 14 885 linhas · 40 ecrãs percorridos no simulador (computador e telemóvel, modo claro e escuro)*

**Critério de entrada.** Cada proposta respondeu a uma pergunta: *isto torna a Compass mais rápida de perceber e mais rápida de usar para um arquiteto com 5 minutos livres entre duas reuniões?* O que não teve um "sim" claro ficou de fora e está listado como tal.

**Resumo em cinco linhas**
1. A base é boa. As cores já estão em variáveis e há tema claro/escuro, ⌘K, "Anular" em 12 sítios, gravação sem botão nas horas e respeito por quem pede menos animação.
2. Os fluxos diários são curtos: registar 2h leva 2 cliques e ver quanto está em dívida leva 1.
3. O problema principal é o **acumulado visual**: 26 tamanhos de letra, 7 pesos, 23 espaçamentos, 20 raios e 35 sombras diferentes, 125 bordas e 208 estilos escritos à mão no meio do código. Tudo tem o mesmo peso e o olho não sabe onde pousar.
4. **Diálogos nativos** do browser (20 "Tem a certeza?" e 10 alertas de erro) quebram o estilo e o ritmo, e no iPhone parecem avisos do sistema.
5. **No telemóvel**, vários controlos ficam abaixo dos 44 px recomendados. Os seletores de estado e de responsável da ficha do projeto têm 19 px de altura.

---

## 1. Inventário

### 1.1 Ecrãs

| Área | Ecrãs e separadores | Janelas (modais) principais |
|---|---|---|
| Hoje | Ponto e placar · Avisos · Próximos 7 dias · Horas · As minhas fases | Corrigir o dia, NPS, marco |
| Projetos | Lista (Ativos / Todos / Arquivados) | Novo projeto |
| Ficha do projeto | Visão geral · Fases · Cronologia · Atas · Câmara · Finanças · Dados | Fase, revisão, pausa, fatura, despesa, marco, prazo, editar projeto, NPS |
| Clientes | Lista (Score / Faturado / Nome) · Ficha do cliente | Cliente, entidade de faturação |
| Faturação | Por faturar · Por receber · Faturas · Por associar | Importar SAF-T, fatura, arquivar |
| Mission Control | Qualidade · Financeiro (Resumo / Movimentos / Impostos) · Tempo | Objetivos, importar extrato |
| Horas | Grelha da semana · Registos | Acrescentar linha, célula com faturável/não faturável |
| Agenda | Mês · Cronograma | Marco |
| Atas | Lista com pesquisa | Nova ata, versões |
| Despesas | Todas · Reembolsos | Despesa |
| Ajuda | Manual "Como é que…" · painel "?" · "Mostra-me" | — |
| Definições | 10 secções | várias |
| Fora da app | Entrada · recuperar palavra-passe · página do cliente NPS | — |

**Pedidos na auditoria que não existem na app:**
- **Pipeline/GPL, MQT e CST** existem só como tabelas de protótipo na base de dados (`gpl_*`, `mqt_*`, `cst_*`), sem nenhum ecrã. A viabilidade faz-se hoje em Excel.
- **Emitir faturas** acontece no weoInvoice. A Compass só importa (SAF-T) e acompanha. Ver as decisões em aberto.

### 1.2 Fluxos principais medidos

| Tarefa | Computador | Telemóvel | Ecrãs |
|---|---|---|---|
| Registar 2h num projeto **que já está na semana** | 2 cliques e escrever "2" (Horas → célula de hoje) | 2 toques | 1 |
| Registar 2h num projeto **que ainda não está na semana** | 6 cliques (Horas → + Acrescentar linha → projeto → fase → Acrescentar → célula) | 6 toques | 1 + janela |
| Saber quanto está **em dívida no total** | 1 clique (Faturação: "Por receber") | 2 toques (Mais → Faturação) | 1 |
| … **de um projeto** | 3 cliques (Projetos → projeto → Finanças) | 3 toques | 2 |
| … **de um cliente** | **não existe**: é preciso somar projeto a projeto | — | — |
| Registar uma despesa | Novo → Registar despesa → 8 campos → Guardar (≈ 10 interações) | igual | janela |
| Mudar o estado de uma fase | 2 cliques (na Hoje ou na ficha) | 2 toques | 0 |
| Ver em que ponto está um projeto | 2 cliques (Projetos → projeto) | 2 toques | 1 |
| Marcar a entrada | 1 toque | 1 toque | 0 |

### 1.3 Componentes repetidos

Cartão (`gantt-wrap`), cabeçalho de cartão (`card-head`), linha de lista (`invoice-row`), pastilha de estado (`invoice-status`, `nps-pill`, `break-pill`), segmentado (`segmented`), azulejo de número (`kpi`, `mc-tile`, `stat-tile`, `hs-tile`: **4 versões do mesmo componente**), botões primário, secundário e de texto, janela rápida (`quick-modal`), toast com "Anular", popover (estado, pessoas), barras e gráficos SVG.

### 1.4 Padrões visuais medidos

| Aspeto | Hoje | O que devia ser |
|---|---|---|
| Cores | ✅ Em variáveis (`--text`, `--accent`…), claro e escuro. Só 36 hexadecimais, quase todos nas próprias variáveis | Manter |
| Tamanhos de letra | ❌ 26 no CSS, mais 28 nos estilos inline (394 ocorrências): 9, 9.5, 10, 10.5, 11, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 17, 18… | 7: 12 · 13 · 14 · 16 · 20 · 28 · 36 (números) |
| Pesos | ❌ 7: 400, 500, 550, 600, 650, 700, 800 | 3: 400 · 600 · 700 |
| Espaçamento | ❌ 23 valores (1, 2, 3, 5, 7, 9, 11, 15 px…) e 131 paddings diferentes | Escala de 4: 4 · 8 · 12 · 16 · 24 · 32 · 48 |
| Raios | ❌ 20 valores (1 a 16 px, 50%, 999 px) | 3: 6 (controlos) · 12 (cartões) · 999 (pastilhas) |
| Sombras | ❌ 35 diferentes | 2: flutuante (menus, janelas) e foco |
| Bordas | ❌ 125 regras com borda de 1 px; cartão com borda, fundo e linha entre cada item | Separar por espaço e fundo; bordas só onde organizam |
| Estilos inline | ❌ 208 `style="…"` no HTML gerado | Classes com tokens |
| Animação | ✅ 20 animações, `prefers-reduced-motion` respeitado em todo o lado | Manter; durações já em tokens (`--t-fast`, `--t`, `--t-slow`) |
| Carregamento | ⚠️ 59 textos "A carregar…" e 3 spinners; sem esqueletos (a atualização silenciosa já evita piscar ao voltar a um ecrã) | Esqueletos nos 5 ecrãs principais |
| Diálogos | ❌ 20 `confirm()` e 10 `alert()` nativos | "Anular" e mensagens dentro da própria janela |
| Teclado | ⚠️ Só ⌘K, `?` e Esc | 4–5 atalhos para o essencial |

### 1.5 Inconsistências principais
- **Quatro versões do "azulejo de número"** (`kpi`, `mc-tile`, `stat-tile`, `hs-tile`), com tamanhos e margens diferentes.
- **Mistura de línguas no ecrã:**
  - *Lead time*, *Work time*, *Checklist*, *Gantt*, *Score*, *Partner*;
  - códigos de estado *WIP / To Do / Done* visíveis nalguns sítios;
  - categorias de horas em inglês (*Financial Management*, *Project Scouting*…).
- **Título repetido** na ficha do projeto: o nome aparece na barra de topo e logo a seguir como título grande.
- **Ações pouco usadas em lugar nobre:** "Arquivar" no canto da ficha do projeto; coluna "Editar" em todas as linhas das despesas, quando a linha inteira já abre.
- **Erros mostrados de três maneiras:** `alert()`, mensagem dentro da janela e toast.

---

## 2. Auditoria por ecrã

Gravidade: **Alta** = atrasa ou engana no dia a dia; **Média** = incomoda ou dispersa; **Baixa** = polimento.

### 2.1 Global e navegação

| # | Problema | Lente | Grav. | Correção proposta |
|---|---|---|---|---|
| G1 | 26 tamanhos de letra e 7 pesos: a hierarquia faz-se com tamanho, e o secundário grita tanto como o principal | Refactoring UI | Média | Escala de 7 tamanhos e 3 pesos em tokens; o secundário ganha cor (`--text-2`), não perde tamanho |
| G2 | Espaçamentos sem escala (23 valores) e 208 estilos inline: o ritmo muda de ecrã para ecrã | Refactoring UI | Média | Escala de 4 px em tokens; os estilos inline passam a classes |
| G3 | 125 bordas: cartão com borda, fundo e divisória em cada linha dá ruído de grelha | Refactoring UI · Rams | Média | Tirar bordas às listas dentro de cartões (separar por espaço); os cartões ficam só com fundo, ou só com borda |
| G4 | 20 raios e 35 sombras | Refactoring UI | Baixa | 3 raios e 2 sombras em tokens |
| G5 | 20 `confirm()` nativos para eliminar ou arquivar: bloqueiam, são feios no iPhone, e "Tem a certeza?" treina a clicar OK sem ler | Norman/Nielsen (H3 controlo, H5 prevenção) | **Alta** | "Anular" durante 8 s nas ações reversíveis (arquivar, eliminar pausa, marco, ponto de situação, fase, fatura, estado, tipo); `confirm()` só no que não tem volta (apagar cliente com projetos, palavra-passe) |
| G6 | 10 `alert()` de erro com texto técnico do servidor | Nielsen (H9 recuperar de erros) | Média | Mensagem na própria janela ou toast de erro, em linguagem simples, com "Tentar outra vez" |
| G7 | No telemóvel e no iPad, alvos abaixo de 44 px: botões do topo 38 px, separadores 32–34 px, **seletores de estado e responsável da ficha com 19 px**, setas do calendário 38 px | Norman (affordance) · Nielsen | **Alta** | Mínimo 44 × 44 px de área tocável em `pointer: coarse` (a área cresce, o desenho pode ficar igual) |
| G8 | O botão redondo **+** tapa o fim das listas no telemóvel (ex.: "faltam 13 dias" escondido na ficha) | Nielsen (H1) · Norman | Média | Espaço no fim do conteúdo igual à altura do botão; esconder o botão ao descer e mostrar ao subir |
| G9 | Carregamento com texto "A carregar…" faz saltar a página quando chega o conteúdo | Karri (velocidade percebida) | Média | Esqueletos com a forma final nos 5 ecrãs principais (Hoje, Projetos, ficha, Faturação, Mission Control) |
| G10 | Título do projeto repetido (barra de topo e título grande) | Karri (calma) · Rams | Baixa | A barra de topo mostra "Projetos ›" e o nome só aparece ao descer, quando o título grande sai do ecrã |
| G11 | Teclado: só ⌘K e `?` | Karri | Baixa | `N` novo, `H` horas, `E` entrada/saída, `/` pesquisar; listados no painel `?` |
| G12 | Pressed e hover inconsistentes (segmentados e linhas clicáveis sem estado pressionado; linhas sem sinal de que abrem) | Rauno/Emil | Baixa | Estado pressionado único (escala 0,98 e fundo) em botões, linhas e segmentados; chevron discreto nas linhas que abrem |
| G13 | Mistura de PT e EN no ecrã | Nielsen (H2 linguagem do utilizador; H4 consistência) | Média | **Decisão tua** (ver secção 5). Recomendo tudo em PT-PT, exceto os nomes próprios Compass e Mission Control |

### 2.2 Hoje

| # | Problema | Lente | Grav. | Correção |
|---|---|---|---|---|
| H1 | A página cresceu: Ponto e Placar, **Avisos (8 ou mais linhas)**, 7 dias, Horas e Fases. No computador, a primeira dobra é quase só avisos | Karri (calma) · Nielsen (H8 minimalismo) | **Alta** | Avisos ordenados por urgência; mostrar os 3 primeiros e "Mais 5 avisos ›"; os lembretes do mês (SAF-T, extrato) só na última semana do mês |
| H2 | Todos os avisos têm o mesmo peso (ícone, título, texto, ação colorida) | Refactoring UI (tirar ênfase ao secundário) | Média | Cor só nos atrasados ou urgentes; os restantes em neutro, com a ação a cinzento |
| H3 | Duas contagens de horas no mesmo ecrã (barra do Ponto "3h40 de 6h" e cartão Horas "10,0h de 30h") sem ligação entre si | Karri (compreensão do problema) · Rams | Média | Uma linha no cartão Horas: "Hoje: 3h40 no escritório · 2h registadas"; o cartão Ponto fica só com a entrada e a saída |

### 2.3 Projetos (lista)

| # | Problema | Lente | Grav. | Correção |
|---|---|---|---|---|
| P1 | As colunas **Área** e **Tipo** ocupam espaço e não servem a pergunta de quem abre a lista ("em que ponto está e o que vem a seguir?") | Karri (design é compreender o problema) · Nielsen (H1) | **Alta** | Trocar por **Fase atual** e **Próximo prazo** (com sinal vermelho se está atrasado ou em pausa). Área e tipo continuam na ficha |
| P2 | O valor a negrito à direita compete com o nome | Refactoring UI | Baixa | Peso normal, cor secundária |

### 2.4 Ficha do projeto

| # | Problema | Lente | Grav. | Correção |
|---|---|---|---|---|
| F1 | **Finanças: 7 cartões com o mesmo peso** e um erro. Com fases fora das contas aparece "Faturado do total 0% · 24 000 € de 0,00 €" e "Honorários NOVA 0,00 €" | Trade Republic (número protagonista) · Nielsen (H1) | **Alta** | Um número grande (**Em dívida**, ou **Por faturar** se não houver dívida); uma linha com Faturado, Recebido e €/h; o resto (despesas, margem, horas) em "Detalhe ›". Corrigir o cálculo |
| F2 | "Arquivar" como botão no canto do cabeçalho: ação rara em lugar nobre | Rams · Karri | Média | Menu "⋯" no cabeçalho com Editar dados e Arquivar |
| F3 | No telemóvel, estado e responsável partem em duas linhas e os seletores têm 19 px | Norman · Nielsen | Alta | Coberto pelo G7; mais uma linha única com duas pastilhas tocáveis |
| F4 | 7 separadores; **Dados** é raramente aberto | Rams | Baixa | "Dados" passa a "Editar" no menu "⋯" (6 separadores). **Decisão tua**: as Atas ficam no seu separador, como pediste antes |
| F5 | Fases fora das contas aparecem a 55% de opacidade: o texto fica com contraste 3,9:1 e o NPS com 2,1:1 | Nielsen · acessibilidade | Baixa | Texto normal com a pastilha "Fora das contas" (já existe na coluna Faturação) |
| F6 | No cronograma da Visão geral, "Hoje" sobrepõe-se ao nome do mês | Refactoring UI | Baixa | Etiqueta "Hoje" por cima da régua dos meses |

### 2.5 Horas

| # | Problema | Lente | Grav. | Correção |
|---|---|---|---|---|
| Hr1 | ✅ A grelha é rápida (2 cliques para 2h). Mas acrescentar um projeto novo à semana leva 6 cliques | Karri | Média | Na janela "Acrescentar linha", pôr primeiro os projetos das minhas fases ativas e os últimos usados, e a fase já escolhida (a fase em curso) |
| Hr2 | Texto de ajuda de 2 linhas por baixo da grelha, sempre visível | Karri (calma) | Baixa | Uma linha curta; o resto vai para o guia "?" |
| Hr3 | O ícone € em cada linha não diz o que é | Norman (affordance) | Baixa | Etiqueta "Fat." / "Não fat." |

### 2.6 Faturação

| # | Problema | Lente | Grav. | Correção |
|---|---|---|---|---|
| Fa1 | ✅ Os números do topo estão certos. "Arquivar" como texto em cada linha tira calma à lista | Refactoring UI | Baixa | Mostrar "Arquivar" só ao passar o rato (computador) ou dentro da linha aberta (telemóvel) |
| Fa2 | Passar de "fase por faturar" para a fatura no weoInvoice obriga a copiar à mão o cliente, o NIF, a descrição e o valor | Norman (prevenir erros) | Média | Botão "Copiar para fatura" na linha: copia o texto pronto a colar |
| Fa3 | **Não há "Em dívida" por cliente** | Nielsen (H1 visibilidade) | Média | Linha "Em dívida: 9 600 € (2 faturas, 1 com +60 dias)" na ficha do cliente e na lista de clientes |

### 2.7 Despesas

| # | Problema | Lente | Grav. | Correção |
|---|---|---|---|---|
| D1 | Coluna "Editar" em todas as linhas, quando a linha inteira já abre | Rams · Refactoring UI | Baixa | Remover |
| D2 | O gráfico "ao longo do tempo" ocupa meio ecrã e não serve a tarefa (registar ou reembolsar) | Karri · Rams | Média | Recolhido por omissão ("Ver evolução ›"), ou movido para Mission Control → Financeiro |
| D3 | Janela com 8 campos | Karri (bons defaults) | Média | Data = hoje, Quem pagou = eu, Reembolsada = não, categoria sugerida pela descrição (como as regras do extrato); o formulário fica com 3 campos visíveis |
| D4 | "Estado: —" nas despesas pagas pela NOVA | Nielsen (H1) | Baixa | Deixar a célula vazia |

### 2.8 Clientes, Mission Control, Agenda, Atas, Definições

| # | Problema | Lente | Grav. | Correção |
|---|---|---|---|---|
| C1 | A ficha do cliente não mostra o que se deve nem o NPS | Nielsen (H1) | Média | Coberto pelo Fa3, mais a média de NPS do cliente |
| M1 | Financeiro: "Carteira e cobrança **16,4 meses**" é jargão; a margem de **97%** engana enquanto os custos não estiverem todos importados | Norman/Nielsen (H2 falar como o utilizador) | Média | "Trabalho em carteira: 16 meses ao ritmo atual"; aviso "custos de x meses por importar" junto à margem |
| M2 | "Ver mais" numa caixa tracejada não parece um botão | Norman (affordance) | Baixa | Botão de texto "Objetivos, tesouraria e custos ›" |
| A1 | Agenda no telemóvel: setas e dias com alvos pequenos | Norman | Baixa | Coberto pelo G7 |
| S1 | Definições: 10 secções, usadas raramente | — | — | Nada a mudar (não passa o critério) |
| J1 | Janelas longas no telemóvel: o "Guardar" fica fora do ecrã | Nielsen (H1, H7 eficiência) | Média | Rodapé fixo da janela com Guardar e Cancelar |

### 2.9 O que está bem e deve ficar
- A Visão geral do projeto responde a "em que ponto está" e "o que vem a seguir".
- Gravar horas sem botão, "Anular" no estado das fases e toasts curtos.
- ⌘K com projetos, ações e ajuda.
- O manual com "Mostra-me".
- A atualização silenciosa ao voltar a um ecrã (não pisca).
- Animações curtas, que respeitam a opção de menos movimento.
- A escala de cores nos dois temas.

---

## 3. Novas interações: avaliação

| Candidata | Situação | Entra? | Justificação | Custo de manutenção |
|---|---|---|---|---|
| Command palette ⌘K | **Já existe** (projetos, ações, ajuda) | Melhorar | Acrescentar "Registar horas em…" e "Ir para a fase…" | Baixo |
| Registo rápido de horas | A grelha já é rápida | Sim, em pequeno | Defaults na "Acrescentar linha" (Hr1). A escrita livre no ⌘K ("2h 25001 lic") fica como opcional | Baixo / Médio |
| Edição inline em tabelas | Já existe onde conta: horas, estado e pessoas das fases, responsável e estado do projeto | Não mais | Editar datas e valores sem janela aumenta erros com pouco ganho | — |
| Atualizações otimistas | Parciais (horas, estado) | Sim, nas ações de 1 toque | Ponto, marcar reembolsada, arquivar | Médio: é preciso reverter se falhar |
| "Anular" em vez de "Tem a certeza?" | 12 sítios já têm | **Sim** | G5 | Médio: guardar 8 s antes de apagar de vez |
| Esqueletos | Não existem | Sim | G9, só nos 5 ecrãs principais | Baixo |
| Progressive disclosure na ficha | Já feita na Visão geral | Sim em Finanças | F1 | Baixo |
| Números-chave protagonistas | Parcial (Faturação, Mission Control) | Sim | F1 e Fa3; "Em dívida" na Hoje dos sócios é **decisão tua** | Baixo |
| Atalhos de teclado | Só ⌘K e `?` | Sim, mínimos | G11 | Baixo |
| Empty states úteis | A maioria já diz o que fazer; poucos têm botão | Sim | Pôr o botão da ação no próprio vazio (ex.: "Sem despesas" com "+ Nova despesa") | Baixo |
| 44 px e gestos no iPad/iPhone | Alvos pequenos | 44 px sim; **gestos não** | Deslizar para arquivar custa manter, descobre-se mal e choca com o scroll | Baixo (44 px) |

---

## 4. Plano priorizado (impacto ÷ esforço)

Passos pequenos e independentes. Cada um acaba com uma explicação, como testar e o teu OK. Esforço: **P** = até 1h, **M** = meio dia, **G** = um dia.

| Ordem | Passo | Resolve | Impacto | Esforço |
|---|---|---|---|---|
| **0** | **Design tokens**: escala de espaçamento, tipografia (7 tamanhos, 3 pesos), raios, sombras, camadas (z-index) e alvo mínimo em variáveis CSS. Os valores atuais "encaixam" no mais próximo. O aspeto quase não muda; é a base para o resto | G1–G4 (base) | Base | M |
| 1 | **Alvos de 44 px** no telemóvel e no iPad, e o botão + deixa de tapar conteúdo | G7, G8, F3, A1 | Alto | P |
| 2 | **Avisos da Hoje**: os 3 mais urgentes, "Mais N", cor só no urgente, lembretes do mês só no fim do mês | H1, H2 | Alto | P |
| 3 | **Erros sem `alert()`**: mensagens na janela ou toast, em linguagem simples | G6 | Médio | P |
| 4 | **Finanças do projeto**: corrigir o cálculo, um número protagonista, detalhe a pedido | F1 | Alto | M |
| 5 | **Esqueletos** nos 5 ecrãs principais | G9 | Médio | P |
| 6 | **Despesas**: sem coluna Editar, gráfico recolhido, janela com defaults (3 campos visíveis) | D1–D4 | Médio | P |
| 7 | **Janelas no telemóvel**: Guardar fixo em baixo | J1 | Médio | P |
| 8 | **Lista de projetos**: Fase atual e Próximo prazo em vez de Área e Tipo | P1, P2 | Alto | M |
| 9 | **"Anular" em vez de "Tem a certeza?"** nas ações reversíveis | G5 | Alto | M |
| 10 | **Cabeçalho do projeto**: título único, menu "⋯" (Editar, Arquivar) | G10, F2, F4 | Médio | P |
| 11 | **Em dívida por cliente** e "Copiar para fatura" | Fa2, Fa3, C1 | Médio | M |
| 12 | **Horas**: defaults na "Acrescentar linha", ajuda mais curta, etiqueta Fat. | Hr1–Hr3 | Médio | P |
| 13 | **Menos bordas e menos pesos**: aplicar os tokens às superfícies (listas sem divisórias, 3 pesos, 4 azulejos → 1) | G1–G4, G12 | Médio | G |
| 14 | **Mission Control → Financeiro** em linguagem clara, com aviso de custos incompletos | M1, M2 | Baixo | P |
| 15 | **Atalhos de teclado** (N, H, E, /) e lista no "?" | G11 | Baixo | P |
| 16 | **Língua**: tudo em PT-PT (depois da tua decisão) | G13 | Médio | P |
| — | *Opcional:* escrita livre de horas no ⌘K ("2h 25001 lic") | Hr1 | Baixo | M |

**Ficam de fora** (não passaram o critério dos 5 minutos): gestos de deslizar, edição inline de datas e valores, redesenho das Definições, mais animações.

---

## 5. Decisões em aberto (dependem de ti)

1. **Língua da interface.** Recomendo **tudo em PT-PT**, mantendo os nomes próprios *Compass* e *Mission Control*:
   - *Lead time* → **Prazo previsto**;
   - *Work time* → **Tempo de trabalho**;
   - *Checklist* → **Lista de verificação** (ou manter *Checklist*, que é comum na obra);
   - *Score* → **Pontuação**;
   - *Partner* → **Sócio**;
   - códigos *WIP / To Do / Done* nunca à vista.
   As categorias de horas em inglês são dados: mudam-se em Definições.
2. **Separador "Dados" da ficha** passa para "Editar" no menu "⋯"? (as Atas ficam no seu separador, como pediste)
3. **"Em dívida" na página Hoje** para os sócios (um número, 0 cliques)? Ou só na Faturação?
4. **Gráfico das despesas**: recolhido nas Despesas, ou mudado para Mission Control → Financeiro?
5. **"Anular" em vez de confirmar** implica que o apagar real acontece 8 segundos depois. Aceitas? Apagar um cliente com projetos continuaria a pedir confirmação.
6. **Pipeline/GPL, MQT e CST** não existem na app (só tabelas de protótipo). Queres que entrem? Com a viabilidade em Excel, proponho tratá-los como projeto à parte, depois desta auditoria.
7. **Emitir faturas** continua no weoInvoice, com a Compass a acompanhar (e o "Copiar para fatura" a ajudar)?

---

*Próximo passo: aguardo a tua aprovação do plano (pode ser parcial, ex.: "0 a 5") e as respostas às decisões acima. Nada foi alterado na app.*
