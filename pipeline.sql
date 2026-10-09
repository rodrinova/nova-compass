-- Pipeline de propostas de honorários (Clientes → Pipeline)
-- Cada proposta guarda o documento completo em "content" (capa, âmbito, valor, pagamento, timeline, opcionais,
-- exclusões, fecho) e os dados de gestão do pipeline. A biblioteca guarda os blocos reutilizáveis em PT e EN.

alter table public.fee_proposals
  add column if not exists content jsonb not null default '{}'::jsonb,
  add column if not exists number int,
  add column if not exists version int not null default 1,
  add column if not exists parent_id uuid references public.fee_proposals(id) on delete set null,
  add column if not exists probability int,
  add column if not exists expected_on date,
  add column if not exists followup_on date,
  add column if not exists lost_reason text,
  add column if not exists lost_note text,
  add column if not exists source text,
  add column if not exists owner_id uuid;
create index if not exists fee_proposals_number_idx on public.fee_proposals(number, version);

create table if not exists public.proposal_library (
  id uuid primary key default gen_random_uuid(),
  kind text not null,            -- service | exclusion | optional | note_value | note_pay | note_scope | text
  grp text,                      -- serviços: grupo "PT|EN"; textos: chave (value_intro, quality, manifesto…)
  title_pt text not null,
  body_pt text,
  title_en text,
  body_en text,
  value_text text,               -- opcionais: "60 €/h" ou "sob consulta|on request"
  default_on boolean not null default false,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.proposal_library enable row level security;
create policy team_only on public.proposal_library for all to authenticated
  using (private.is_team_member()) with check (private.is_team_member());

-- Registo CST partilhado: oportunidades do Intelligence e propostas de honorários (AAXXX)
alter table public.land_plots add column if not exists cst int;

-- Biblioteca inicial (a partir das propostas CST 2505, 2519, 2523 e 2622)
-- 88 blocos
insert into public.proposal_library (kind, grp, title_pt, body_pt, title_en, body_en, value_text, default_on, sort) values
('service', 'A \ Projeto de Arquitetura|A \ Architecture Project', 'A1 \ Análise de Viabilidade e Apoio ao Investimento', '**Esta fase avalia a viabilidade legal, económica e estratégica do projeto.** A NOVA aborda cada estudo numa perspetiva de otimização, alinhando a visão de projeto com a viabilidade regulamentar, a eficiência de custos e o valor de mercado. Com o contributo dos nossos parceiros estratégicos de marketing, combinamos conhecimento arquitetónico, legal e comercial para definir a estratégia de desenvolvimento mais coerente e rentável.', 'A1 \ Feasibility & Investment Analysis and Support', '**This stage assesses the project''s legal, economic, and strategic viability.** NOVA approaches every study from an optimisation perspective, aligning design vision with regulatory feasibility, cost efficiency, and market value. With input from our strategic marketing partners, we combine architectural, legal, and commercial insight to define the most coherent and profitable development strategy.', null, false, 1),
('service', 'A \ Projeto de Arquitetura|A \ Architecture Project', 'A2 \ Estudo Prévio', '**Esta fase dá forma e espaço à visão do projeto.** A NOVA define o conceito, a lógica espacial e a identidade do edifício, equilibrando criatividade, função e regulamentação. A proposta é apresentada ao Cliente para feedback, seguida de uma ronda de revisão para afinar e validar o desenho antes de avançar para a fase seguinte.', 'A2 \ Concept Design', '**This stage shapes the project''s vision into space and form.** NOVA defines the concept, spatial logic, and identity of the building, ensuring balance between creativity, function, and regulation. The proposal is presented for client feedback, followed by a revision round to refine and validate the design before advancing to the next phase.', null, false, 2),
('service', 'A \ Projeto de Arquitetura|A \ Architecture Project', 'A3 \ Projeto de Licenciamento', '**Esta fase consolida o estudo aprovado no processo de licenciamento a submeter à Câmara Municipal.** A NOVA prepara todas as peças desenhadas e escritas e a coordenação necessárias, garantindo o cumprimento dos instrumentos de planeamento e da regulamentação em vigor.', 'A3 \ Licensing Design', '**This stage consolidates the approved design into the licensing package for submission to the local authority.** NOVA prepares all required drawings, reports, and coordination elements, ensuring compliance with planning and regulatory frameworks.', null, false, 3),
('service', 'A \ Projeto de Arquitetura|A \ Architecture Project', 'A4 \ Projeto de Execução', '**Esta fase transforma o conceito aprovado num projeto construível e pronto a concurso.** A NOVA desenvolve as peças desenhadas de pormenor e o Mapa de Quantidades que orientam a obra, garantindo precisão, coordenação e conformidade.', 'A4 \ Technical Design', '**This stage transforms the approved concept into a buildable and tenderable project.** NOVA develops the detailed drawings, and a Bill of Quantities that guide construction, ensuring precision, coordination, and compliance.', null, false, 4),
('service', 'A \ Projeto de Arquitetura|A \ Architecture Project', 'A5 \ Engenharia de Valor', '**Esta fase otimiza o projeto com base nos orçamentos dos empreiteiros em concurso.** A NOVA analisa e ajusta as soluções propostas para reduzir custos sem comprometer a qualidade — ou melhorar a qualidade sem aumentar custos. O objetivo é afinar o projeto de forma inteligente, garantindo o melhor equilíbrio entre desempenho, valor e integridade arquitetónica.', 'A5 \ Value Engineering', '**This stage focuses on optimising the project based on the contractors'' tender budgets.** NOVA analyses and adjusts the proposed solutions to reduce costs without compromising quality — or enhance quality without increasing costs. The goal is to refine the design intelligently, ensuring the best balance between performance, value, and architectural integrity.', null, false, 5),
('service', 'A \ Projeto de Arquitetura|A \ Architecture Project', 'A6 \ Comunicação Prévia e Propriedade Horizontal', '**Esta fase consolida o projeto aprovado no processo completo a submeter à Câmara Municipal.** A NOVA prepara todas as peças desenhadas, escritas e de coordenação para o procedimento de *Comunicação Prévia*, garantindo o cumprimento dos instrumentos de planeamento e da regulamentação. Em paralelo, é desenvolvida a definição da Propriedade Horizontal (*PH*), estabelecendo a divisão legal e espacial do edifício para efeitos de propriedade e registo.', 'A6 \ Pre-Application Design Stage and Horizontal Property (*Comunicação Prévia + PH*)', '**This stage consolidates the approved design into the full licensing package for submission to the local authority.** NOVA prepares all required drawings, reports, and coordination elements for the *Comunicação Prévia* procedure, ensuring compliance with planning and regulatory frameworks. In parallel, the Horizontal Property (*PH*) definition is developed, establishing the legal and spatial subdivision of the building for ownership and registration purposes.', null, false, 6),
('service', 'A \ Projeto de Arquitetura|A \ Architecture Project', 'A7 \ Assistência Técnica em Obra', '**Durante a obra, a NOVA presta apoio técnico contínuo para garantir que a execução se mantém fiel ao projeto aprovado.** A nossa equipa realiza visitas periódicas à obra, responde a dúvidas técnicas e apoia na resolução de imprevistos. Esta fase salvaguarda a qualidade e a coerência do projeto ao longo da construção.', 'A7 \ Construction Technical Assistance', '**During construction, NOVA provides ongoing technical support to ensure that the execution remains faithful to the approved design.** Our team conducts periodic site visits, reviews technical queries, and assists in addressing unforeseen conditions. This stage safeguards design quality and coherence throughout the construction process, ensuring a smooth transition from project to reality.', null, false, 7),
('service', 'A \ Projeto de Arquitetura|A \ Architecture Project', 'A8 \ Licença de Utilização', '**A NOVA presta apoio técnico ao processo de Licença de Utilização, desde que este decorra sem alterações ao projeto aprovado.** Caso surjam alterações que obriguem à preparação de telas finais, a sua produção fica fora do âmbito dos presentes serviços.', 'A8 \ Usage Licence', '**NOVA provides technical support for the Usage Licence process, provided that it proceeds without changes to the approved project.** Should any modifications arise requiring the preparation of as-built drawings (telas finais), their production falls outside the present scope of services.', null, false, 8),
('service', 'B \ Projetos de Engenharia|B \ Engineering Projects', 'B1 \ Projeto de Segurança Contra Incêndio', 'Definição das medidas de proteção passiva e ativa contra incêndio, garantindo o cumprimento integral da regulamentação e das normas de segurança aplicáveis.', 'B1 \ Fire Safety Project', 'Definition of passive and active fire protection measures, ensuring full compliance with applicable regulations and safety standards.', null, false, 9),
('service', 'B \ Projetos de Engenharia|B \ Engineering Projects', 'B2 \ Projeto de Estabilidade, Escavação e Contenção Periférica', 'Projeto estrutural do edifício e de todos os elementos de suporte, incluindo fundações, muros de suporte e sistemas de contenção, garantindo estabilidade e segurança durante a construção e a utilização.', 'B2 \ Stability, Excavation and Peripheral Containment Project', 'Structural design of the building and all supporting elements, including foundations, retaining walls and containment systems, ensuring stability and safety throughout construction and operation.', null, false, 10),
('service', 'B \ Projetos de Engenharia|B \ Engineering Projects', 'B3 \ Projeto de Abastecimento de Águas', 'Projeto da rede interior de distribuição de água, garantindo eficiência, acessibilidade e cumprimento dos requisitos regulamentares.', 'B3 \ Water Supply Project', 'Design of the internal water distribution system, ensuring efficiency, accessibility and compliance with regulatory requirements.', null, false, 11),
('service', 'B \ Projetos de Engenharia|B \ Engineering Projects', 'B4 \ Projeto de Drenagem de Águas Residuais', 'Projeto da rede de recolha e descarga de águas residuais, otimizando o desempenho e garantindo a conformidade sanitária e ambiental.', 'B4 \ Wastewater Drainage Project', 'Design of the wastewater collection and discharge network, optimising performance and ensuring sanitary and environmental compliance.', null, false, 12),
('service', 'B \ Projetos de Engenharia|B \ Engineering Projects', 'B5 \ Projeto de Drenagem de Águas Pluviais', 'Projeto dos sistemas de recolha, retenção e escoamento de águas pluviais, promovendo a sustentabilidade e a proteção da envolvente do edifício.', 'B5 \ Rainwater Drainage Project', 'Design of systems for collection, retention and disposal of rainwater, promoting sustainability and protection of the building envelope.', null, false, 13),
('service', 'B \ Projetos de Engenharia|B \ Engineering Projects', 'B6 \ Projeto de Condicionamento Acústico', 'Definição das soluções construtivas que garantem o conforto acústico e o cumprimento regulamentar entre frações e espaços comuns.', 'B6 \ Acoustic Performance Project', 'Definition of constructive solutions to ensure acoustic comfort and regulatory compliance between functional units and shared spaces.', null, false, 14),
('service', 'B \ Projetos de Engenharia|B \ Engineering Projects', 'B7 \ Projeto de Aquecimento, Ventilação e Ar Condicionado (AVAC)', 'Desenvolvimento das soluções de ventilação e climatização que garantem conforto, eficiência energética e qualidade do ar interior.', 'B7 \ Heating, Ventilation and Air Conditioning System Design (HVAC)', 'Development of ventilation and climate-control solutions that ensure comfort, energy efficiency and indoor air quality.', null, false, 15),
('service', 'B \ Projetos de Engenharia|B \ Engineering Projects', 'B8 \ Projeto de Instalações Elétricas', 'Projeto da instalação e da rede de distribuição elétrica, garantindo segurança, eficiência e cumprimento das normas em vigor.', 'B8 \ Power Supply and Electrical Layout Project', 'Design of the electrical installation and distribution network, ensuring safety, efficiency and compliance with current standards.', null, false, 16),
('service', 'B \ Projetos de Engenharia|B \ Engineering Projects', 'B9 \ Projeto de Telecomunicações (ITED)', 'Projeto da infraestrutura de telecomunicações de acordo com o regulamento ITED, garantindo conectividade e integração com os sistemas atuais.', 'B9 \ Telecommunications System Design (ITED)', 'Design of the telecommunications infrastructure in accordance with ITED regulations, ensuring connectivity and integration with modern systems.', null, false, 17),
('service', 'B \ Projetos de Engenharia|B \ Engineering Projects', 'B10 \ Projeto de Instalações Eletromecânicas', 'Definição e coordenação dos sistemas técnicos que envolvem elevadores e outros componentes eletromecânicos do edifício.', 'B10 \ Electromechanical Equipment Project', 'Definition and coordination of technical systems involving lifts, and other electromechanical components of the building.', null, false, 18),
('service', 'B \ Projetos de Engenharia|B \ Engineering Projects', 'B11 \ Projeto de Comportamento Térmico e Pré-Certificação Energética', 'Estudo do desempenho térmico e pré-certificação da eficiência energética do edifício, alinhados com os objetivos de sustentabilidade e regulamentares.', 'B11 \ Thermal Project and Pre-Certification', 'Thermal performance study and pre-certification of the building''s energy efficiency, ensuring alignment with sustainability and regulatory objectives.', null, false, 19),
('service', 'B \ Projetos de Engenharia|B \ Engineering Projects', 'B12 \ Projeto de Gás', 'Projeto da rede de abastecimento de gás, garantindo segurança e cumprimento regulamentar.', 'B12 \ Gas Supply Project', 'Design of the gas supply network, ensuring safety and regulatory compliance.', null, false, 20),
('service', 'C \ Marketing|C \ Marketing', 'C1 \ Identidade de Marca', 'Criação da identidade visual e verbal do empreendimento, incluindo nome, assinatura, logótipo, paleta de cores e tipografia. Esta fase define o tom e a coerência de todos os materiais de comunicação seguintes.', 'C1 \ Brand Identity', 'Creation of the project''s visual and verbal identity, including naming, tagline, logotype, colour palette, and typography. This stage defines the tone and coherence of all subsequent communication materials.', null, false, 21),
('service', 'C \ Marketing|C \ Marketing', 'C2 \ Visualização Arquitetónica (imagens fotorrealistas)', 'Produção de imagens de alta qualidade — exteriores e interiores — que ilustram a atmosfera, a materialidade e o carácter espacial do projeto. Estas imagens são a base de toda a comunicação e promoção.', 'C2 \ Architectural Visualisation (photorealistic renderings)', 'Production of high-quality images — exterior and interior — that illustrate the project''s atmosphere, materiality, and spatial character. These visuals serve as the core of all communication and promotional materials.', null, false, 22),
('service', 'C \ Marketing|C \ Marketing', 'C3 \ Plantas Comerciais', 'Desenvolvimento de plantas comerciais individuais por fração, com cores, áreas e tipologias. Cada fração é detalhada graficamente para uma apresentação clara e uso comercial.', 'C3 \ Commercial Floor Plan Layouts', 'Development of individual floor plan layouts, colour-coded and annotated with areas and typologies. Each unit is graphically detailed for clear presentation and commercial use.', null, false, 23),
('service', 'C \ Marketing|C \ Marketing', 'C4 \ Brochura Digital', 'Desenho de uma brochura concisa e visualmente apelativa que capta a essência do empreendimento — a arquitetura, a atmosfera e a história — através de imagens coerentes, informação clara e composição cuidada.', 'C4 \ Digital Brochure', 'Design of a concise, visually engaging brochure that captures the essence of the development. More than a presentation tool, it conveys the project''s tangible and intangible value — its architecture, atmosphere, and story — through coherent imagery, clear information, and refined composition.', null, false, 24),
('service', 'D \ Fiscalização Independente de Obra|D \ Independent Construction Inspection', 'Fiscalização Independente de Obra', '**Esta fase garante uma supervisão independente e rigorosa da obra. A NOVA nomeia um parceiro externo certificado para a fiscalização**, garantindo total autonomia e imparcialidade técnica. A equipa verifica a conformidade entre o projeto aprovado, as especificações técnicas e a execução em obra, emitindo relatórios que asseguram transparência, segurança e qualidade durante a construção.', 'Independent Construction Inspection', '**This stage ensures independent and rigorous supervision of the construction process. NOVA appoints a certified external partner to perform the inspection**, guaranteeing full autonomy and technical impartiality. The inspection team verifies compliance between the approved project, technical specifications, and on-site execution, issuing reports that ensure transparency, safety, and quality throughout the construction phase.', null, false, 25),
('service', 'Levantamento Arquitetónico|Architectural Survey', 'Visita ao local para levantamento rigoroso e completo de todas as áreas, compartimentos e elementos relevantes para o projeto', '', 'Site visit for an accurate and complete survey of all areas, rooms and elements relevant to the project', '', null, false, 26),
('service', 'Levantamento Arquitetónico|Architectural Survey', 'Modelação da Pré-Existência em 3D como base de trabalho', '', '3D modelling of the existing building as a working base', '', null, false, 27),
('service', 'Estudo Conceptual|Conceptual Study', 'Desenvolvimento de Layout de Interiores e Configuração Espacial', '', 'Interior layout and spatial configuration', '', null, false, 28),
('service', 'Estudo Conceptual|Conceptual Study', 'Estudo de Materiais e Atmosfera através de Realidades Virtuais (Imagens 3D)', '', 'Materials and atmosphere study through virtual renderings (3D images)', '', null, false, 29),
('service', 'Preparação de Obra|Construction Preparation', 'Reunião com Cliente e Empreiteiro para feedback e otimização de projeto para Obra', '', 'Meeting with Client and Contractor for feedback and optimisation of the design for construction', '', null, false, 30),
('service', 'Preparação de Obra|Construction Preparation', 'Revisão do Estudo Conceptual', '', 'Revision of the Conceptual Study', '', null, false, 31),
('service', 'Preparação de Obra|Construction Preparation', 'Apoio ao Esclarecimento de Dúvidas durante a Obra (até 2 visitas presenciais)', '', 'Support with queries during construction (up to 2 site visits)', '', null, false, 32),
('service', 'Estudo Prévio|Concept Design', 'Plantas 1:100', '', 'Floor plans 1:100', '', null, false, 33),
('service', 'Estudo Prévio|Concept Design', 'Cortes 1:100', '', 'Sections 1:100', '', null, false, 34),
('service', 'Estudo Prévio|Concept Design', 'Alçados 1:100', '', 'Elevations 1:100', '', null, false, 35),
('service', 'Estudo Prévio|Concept Design', 'Axonometrias ou Imagens Tridimensionais de Conceito', '', 'Axonometric views or 3D concept images', '', null, false, 36),
('service', 'Pedido de Informação Prévia|Pre-Application Enquiry (PIP)', 'Plantas 1:100', '', 'Floor plans 1:100', '', null, false, 37),
('service', 'Pedido de Informação Prévia|Pre-Application Enquiry (PIP)', 'Cortes 1:100', '', 'Sections 1:100', '', null, false, 38),
('service', 'Pedido de Informação Prévia|Pre-Application Enquiry (PIP)', 'Alçados 1:100', '', 'Elevations 1:100', '', null, false, 39),
('service', 'Pedido de Informação Prévia|Pre-Application Enquiry (PIP)', 'Memória Descritiva', '', 'Design statement', '', null, false, 40),
('service', 'Pedido de Informação Prévia|Pre-Application Enquiry (PIP)', 'Termo de responsabilidade do Autor de Projeto', '', 'Statement of responsibility of the Project Author', '', null, false, 41),
('service', 'Pedido de Informação Prévia|Pre-Application Enquiry (PIP)', 'Termo de responsabilidade do Coordenador de Projeto', '', 'Statement of responsibility of the Project Coordinator', '', null, false, 42),
('service', 'Estudo Prévio de Layout Funcional|Functional Layout Study', 'Visita de Reconhecimento e Estudo às instalações atuais', '', 'Survey visit to the existing facilities', '', null, false, 43),
('service', 'Estudo Prévio de Layout Funcional|Functional Layout Study', 'Reunião de Definição Estratégica e acerto de Programa', '', 'Strategy and brief definition meeting', '', null, false, 44),
('service', 'Estudo Prévio de Layout Funcional|Functional Layout Study', 'Modelação 3D da Preexistência', '', '3D modelling of the existing building', '', null, false, 45),
('service', 'Estudo Prévio de Layout Funcional|Functional Layout Study', 'Desenvolvimento do Novo Layout de Áreas Comuns e Conceito de Projeto', '', 'New layout of common areas and design concept', '', null, false, 46),
('service', 'Estudo Prévio de Layout Funcional|Functional Layout Study', 'Reunião de Apresentação, e entrega de Plantas de Layout e Sobreposição (Vermelhos e Amarelos)', '', 'Presentation meeting and delivery of layout and overlay plans (reds and yellows)', '', null, false, 47),
('exclusion', '', 'Taxas Camarárias, Licenças ou outras exigências das Entidades Licenciadoras', '', 'Municipal Fees, Licences, or other requirements requested by the Licensing Authorities', '', null, true, 48),
('exclusion', '', 'Projeto de Enquadramento Ambiental, Sondagens, Estudo de Tráfego ou outros', '', 'Environmental Assessment, Geotechnical Surveys, Traffic Studies, or similar reports', '', null, true, 49),
('exclusion', '', 'Projetos de Especialidades não mencionados neste documento', '', 'Engineering Disciplines not specified in this document', '', null, true, 50),
('exclusion', '', 'Intervenção fora dos limites do terreno', '', 'Intervention beyond the boundaries of the plot', '', null, true, 51),
('exclusion', '', 'Projeto de Interiores e Mobiliário', '', 'Interior Design and Loose Furniture Design', '', null, false, 52),
('exclusion', '', 'Telas Finais, Licença de Utilização ou outros elementos não especificados', '', 'Documentation related to As-Built Drawings, Usage Licences, or other items not specified herein', '', null, false, 53),
('exclusion', '', 'Maquetas, Ilustrações, Realidades Virtuais ou outros elementos de comunicação comercial', '', 'Physical Models, or other non-mentioned commercial communication materials', '', null, true, 54),
('exclusion', '', 'Entrega de Ficheiros / Modelos Editáveis ou em formato Papel', '', 'Delivery of Editable or 3D Printed Models', '', null, true, 55),
('exclusion', '', 'Revisões ou Elementos Escritos ou Desenhados não contemplados neste documento', '', 'Revisions or Written/Graphic Elements not included in this document', '', null, true, 56),
('exclusion', '', 'Levantamento arquitetónico ou topográfico', '', 'Architectural or topographic survey', '', null, false, 57),
('exclusion', '', 'Reuniões de certificação regulamentar junto da Câmara Municipal ou outras entidades', '', 'Regulatory certification meetings with the Municipality or other entities', '', null, false, 58),
('exclusion', '', 'Avaliação técnica do estado de conservação do edifício', '', 'Technical assessment of the condition of the building', '', null, false, 59),
('exclusion', '', 'Qualquer fase de projeto subsequente ao presente estudo', '', 'Any design stage following the present study', '', null, false, 60),
('optional', '', 'Assistência Técnica em Obra (visita extraordinária)', '', 'Construction Technical Assistance (extra site visit)', '', '60 €/h', false, 61),
('optional', '', 'Levantamento Topográfico', '', 'Topographic Survey', '', 'sob consulta|on request', false, 62),
('optional', '', 'Imagens 3D complementares ou Realidades Virtuais', '', 'Additional 3D images or virtual renderings', '', 'sob consulta|on request', false, 63),
('optional', '', 'Cedência de Modelos Editáveis', '', 'Delivery of Editable Models', '', 'sob consulta|on request', false, 64),
('note_value', '', 'Aos valores apresentados acresce IVA à taxa legal em vigor.', '', 'VAT will be applied at the prevailing rate.', '', null, true, 65),
('note_value', '', 'Aumentos de área superiores a 5% poderão resultar em ajuste de honorários.', '', 'Area increases above 5% may result in a fee adjustment.', '', null, false, 66),
('note_value', '', 'Qualquer aumento do número de frações resulta num ajuste automático dos honorários.', '', 'Any increase in the number of residential units will result in an automatic adjustment of fees.', '', null, false, 67),
('note_value', '', 'O número de visitas pressupõe um prazo de obra de 18 meses. Caso a obra termine antes de cumpridas todas as visitas, o valor remanescente é faturado com a última visita.', '', 'The number of site visits assumes a construction period of 18 months. Should construction be completed prior to the full number of visits, the remaining balance will be invoiced upon the final visit.', '', null, false, 68),
('note_value', '', 'Prémio de desempenho: 10% sobre a diferença entre o valor de venda e o target de venda definido pelo Cliente.', '', 'Performance fee: 10% of the difference between the sale value and the sale target set by the Client.', '', null, false, 69),
('note_value', '', 'O valor do presente estudo será integralmente abatido aos honorários globais do projeto, caso este seja adjudicado à NOVA Associates.', '', 'The value of this study will be fully deducted from the overall project fees, should the project be commissioned to NOVA Associates.', '', null, false, 70),
('note_pay', '', 'A liquidação das faturas deverá ser efetuada a pronto pagamento após a sua emissão.', '', 'All invoices are due for settlement in full upon issuance.', '', null, true, 71),
('note_pay', '', 'Pedidos de alterações pelo Cliente devem ser feitos no prazo máximo de duas semanas após a apresentação ou entrega da fase correspondente, podendo aplicar-se custos mediante a natureza e a complexidade dos mesmos.', '', 'Client requests for design changes must follow the agreed schedule. Substantial or extensive revisions may incur additional costs, and adjustments to the project timeline may apply depending on their nature and complexity.', '', null, false, 72),
('note_pay', '', 'Interrupções de Projeto por prazo superior a 180 dias cessam a validade da proposta.', '', 'Project interruptions longer than 180 days end the validity of this proposal.', '', null, false, 73),
('note_pay', '', 'A interrupção ou cessação do Projeto implica a faturação automática de todo o trabalho não faturado, incluindo o valor proporcional da fase em curso.', '', 'Project interruption or termination shall result in automatic invoice of any non-invoiced work including the current stage''s proportional value of completion.', '', null, false, 74),
('note_scope', '', 'Em concordância com os mais atuais padrões de ESG, o fornecimento de entregáveis toma lugar em formato digital.', '', 'In line with current ESG standards, all deliverables will be provided in digital format.', '', null, true, 75),
('note_scope', '', 'O desenvolvimento do projeto de AVAC pressupõe a entrega atempada do programa da especialidade definido na fase de Estudo Prévio.', '', 'The development of the HVAC Design assumes the timely provision of the specialty brief defined during the Preliminary Design phase.', '', null, false, 76),
('text', 'scope_lead', 'Com base nos pressupostos anteriores, os elementos abrangidos pela presente proposta são:', '', 'Based on the above, the general scope of the proposal covers the following disciplines:', '', null, false, 77),
('text', 'value_intro', 'Valor — Respeito', 'Respeitamos cada Projeto e cada Cliente, procurando dedicar a cada um o tempo certo ao desenvolvimento inteligente de soluções que fazem sentido, e trazem impacto a cada História, e cada Pessoa. Esta proposta reflete este princípio:', 'Value — Respect', 'We respect every Project and every Client, dedicating to each the right time for the intelligent development of solutions that make sense and bring impact to every Story and every Person. This proposal reflects this principle:', null, true, 78),
('text', 'value_intro', 'Valor — Impacto', '**Creating Impact. Driving Results. Building Legacy** — com discernimento, visão e foco claro no valor. Cada projeto é uma oportunidade para **otimizar Proporção, Beleza, Espaço, Funcionalidade e Investimento**. Esta proposta reflete o nosso compromisso com a qualidade, a transparência e o desenho com propósito.', 'Value — Impact', '**Creating Impact. Driving Results. Building Legacy** — with discernment, vision, and a clear focus on value. Every project is an opportunity to **optimise Proportion, Beauty, Space, Functionality, and Investment**. This proposal reflects our commitment to quality, transparency, and purposeful design.', null, false, 79),
('text', 'value_intro', 'Valor — Fazer Bem Feito', '**Fazer Bem Feito** é o que nos move — **com o tempo, critério e respeito**. Respeito por quem irá habitar o espaço que juntos desenhamos, por cada decisão que influencia a forma como se vive, e pelo impacto que um projeto bem pensado pode ter ao longo dos anos. Não procuramos atalhos, nem seguimos a lógica do mais barato. Procuramos o que é essencial, o que dura, o que acrescenta valor real ao quotidiano. Esta proposta reflete esse compromisso: com a qualidade, com a transparência e com a responsabilidade de construir, desde já, uma vida melhor no lugar que virá a ser casa.', 'Value — Doing It Right', '**Doing it right** is what drives us — **with time, judgement and respect**. Respect for those who will live in the space we design together, for every decision that shapes the way people live, and for the impact a well-thought-out project can have over the years. We do not look for shortcuts, nor follow the logic of the cheapest. We look for what is essential, what lasts, what adds real value to everyday life. This proposal reflects that commitment.', null, false, 80),
('text', 'pay_intro', 'Pagamento — Investimento', 'Um Projeto é sempre um investimento. Como tal, propomos um faseamento dos pagamentos de acordo com o faseamento dos entregáveis de Projeto, conforme a tabela abaixo:', 'Payment — Investment', 'The payment schedule follows the project''s natural rhythm. Fees are divided into balanced stages, ensuring transparency and a fair link between progress and payment. This approach fosters financial clarity and a seamless flow throughout the process.', null, true, 81),
('text', 'pay_intro', 'Pagamento — Etapas', 'Tal como o **projeto se estrutura em etapas**, também os **pagamentos acompanham este ritmo**. Dividimos o investimento em fases para que tudo seja claro, equilibrado e proporcional ao avanço do trabalho. Assim, **cada passo tem o seu tempo, o seu valor** — e faz parte de um caminho bem feito, do início ao fim.', 'Payment — Stages', 'Just as the **project is structured in stages**, **payments follow the same rhythm**. We divide the investment into phases so that everything is clear, balanced and proportional to the progress of the work.', null, false, 82),
('text', 'timeline_intro', 'Timeline', 'O cronograma reflete a sequência e a duração previstas de cada fase, do conceito à conclusão. Serve de guia visual para acompanhar o progresso, coordenar especialidades e manter o alinhamento entre projeto, aprovações e obra.', 'Timeline', 'The Gantt timeline reflects the expected sequence and duration of each project stage, from concept to completion. It serves as a visual guide to monitor progress, coordinate disciplines, and maintain alignment between design, approvals, and construction milestones.', null, true, 83),
('text', 'timeline_note', 'Nota do timeline', 'Este cronograma é indicativo e depende da entrega atempada pelo Cliente de toda a informação, documentação e decisões necessárias, bem como da rapidez das aprovações do Cliente, consultores e entidades em cada fase. Qualquer atraso, omissão ou alteração ao programa, âmbito ou parâmetros de projeto pode afetar o calendário acordado.', 'Timeline note', 'This timeline is indicative and contingent upon the timely provision by the Client of all necessary information, documentation, and decisions required for the progression of the project. It also assumes prompt feedback and approvals from the Client, consultants, and relevant authorities at each stage. Any delay, omission, or modification to the project brief, scope, or design parameters may affect the agreed schedule.', null, true, 84),
('text', 'optionals_intro', 'Opcionais', 'Mais do que Arquitetura, a **NOVA** oferece um leque de **serviços opcionais**, orientados para **dar conforto ao Cliente** e **potenciar o valor do produto final**:', 'Optionals', 'More than Architecture, **NOVA** offers a range of **optional services**, designed to **give comfort to the Client** and **enhance the value of the final product**:', null, true, 85),
('text', 'exclusions_intro', 'Exclusões', 'Os seguintes serviços não estão incluídos no âmbito da presente proposta:', 'Exclusions', 'The following services are outside the scope of this proposal:', null, true, 86),
('text', 'quality', 'Porque merecemos Qualidade', 'Acreditamos que o sucesso de cada projeto reside na proximidade e no cuidado dedicados a cada Cliente.

Para garantir um processo personalizado e eficiente, **será designado um Arquiteto Gestor de Projeto, responsável por liderar uma equipa experiente e totalmente empenhada em prestar apoio integral em todas as fases.**

A assinatura deste documento constitui a validação e adjudicação formal do trabalho, devendo ser enviada por e-mail à NOVA Associates.', 'With the Courtesy of Gentlepeople', 'We believe that the success of every project lies in the closeness and care dedicated to every single one of our Clients.

To ensure a personalised and efficient process, **a dedicated Architect Project Manager will be appointed to lead an experienced team fully committed to providing comprehensive support throughout every stage of the project**.

**NOVA will manage the entire coordination process with the relevant licensing authorities,** facilitating all required procedures for the proper development of the project. The Client''s collaboration is kindly requested in promptly sharing any direct communications received from the Licensing Authority.

Following the commissioning of the Project, a Kick-Off Meeting will be held to introduce the Project Manager who will personally accompany the Client throughout all phases. This person will act as the main point of contact, ensuring continuous and transparent communication.

The signature of this document shall serve as validation and formal commissioning of the work, and should subsequently be sent by email to NOVA Associates.', null, true, 87),
('text', 'manifesto', 'Uma casa NOVA. Manifesto.', 'Vivemos no tempo da pressa.
Crescemos rápido. Trabalhamos rápido.
Comemos, bebemos, dormimos rápido.

Esquecemos rápido o que vemos rápido.
Amamos rápido. Fartamos rápido.
Quando não enviamos emojis, escrevemos dprs.

Pressa não é progresso.
Pressa é urgência. E a urgência rouba o presente.

Mas há um outro ritmo.
Há um tempo onde o sabor é mais profundo,
Onde o respeito pela vida é maior.

Onde as coisas acontecem no seu tempo,
Sem pressa, mas com mais sentido.

Porque a vida, a verdadeira vida, não é para ontem.
É para hoje, e para amanhã.

E a Casa?

A Casa é o nosso refúgio, o lugar onde a pressa fica para trás.
É onde celebramos a Natureza, a Vida e o que nos torna únicos.
A Casa é a nossa história, as nossas memórias,
O espaço onde crescemos e evoluímos.

É o projeto da nossa vida,
Sempre em construção,
Sempre em aberto,
Sempre nosso.

Vamos começar?', 'A NOVA home. Manifesto.', 'We live in times of haste.
We grow up fast. We work fast.
We eat, drink and sleep fast.

We quickly forget what we quickly see.
We love fast. We tire fast.

Haste is not progress.
Haste is urgency. And urgency steals the present.

But there is another rhythm.
A time where flavour runs deeper,
Where respect for life is greater.

Where things happen in their own time,
Without hurry, but with more meaning.

Because life, real life, is not for yesterday.
It is for today, and for tomorrow.

And the Home?

The Home is our refuge, the place where haste is left behind.
It is where we celebrate Nature, Life and what makes us unique.
The Home is our story, our memories,
The space where we grow and evolve.

It is the project of our life,
Always under construction,
Always open,
Always ours.

Shall we begin?', null, false, 88);

-- Estados do pipeline (a tabela original só aceitava draft/sent/accepted/declined)
alter table public.fee_proposals drop constraint if exists fee_proposals_status_check;
alter table public.fee_proposals add constraint fee_proposals_status_check check (status = any (array['draft','sent','negotiation','accepted','declined','superseded']));
