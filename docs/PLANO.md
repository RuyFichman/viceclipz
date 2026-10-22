# ViceClipz — plano de execução

Atualizado em 21/10/2026. Nome provisório derivado do workspace. Projeto independente, inspirado no fluxo do Vicescale, com identidade e código próprios.

## Diagnóstico da referência

Fonte: https://vicescale.com/, consultada em 21/10/2026, incluindo inspeção visual no navegador. Somente a página pública foi analisada; não tivemos acesso ao aplicativo autenticado.

A proposta combina upload, templates, multiplicação de conteúdo e agendamento social para creators de GTA 6. A página também anuncia coleta/repostagem, conteúdos de formação e integração com Claude. Essas são alegações do fornecedor, não recursos testados nesta análise.

Oportunidades: mostrar o produto antes de pedir contratação; permitir revisar variações; explicar cotas compartilhadas e falhas; simplificar o primeiro projeto. A oferta e o FAQ da referência apresentam informações divergentes sobre acesso à Academy. Nossa proposta terá uma fonte única de configuração para permissões e planos. Não vamos prometer viralização ou ganhos sem evidência.

## Três etapas, com entregas verificáveis

### 1. Fundação e experiência navegável — implementada

- Definição do público inicial: criadores de vídeos curtos, começando por gaming; outros nichos podem usar os mesmos templates.
- Identidade original ViceClipz: paleta pôr do sol (rosa, laranja e violeta) sobre tons escuros, tipografia editorial e composições gráficas próprias.
- Visão geral, projetos, templates com filtros, planejamento por data e editor de prévia.
- Cadastro e edição de rascunhos no armazenamento local do navegador; busca por nome.
- Vídeo local na prévia, headline, três proporções, três templates e sugestões determinísticas de títulos.
- Critério: usuário cria, revisa, salva, encontra e reabre um rascunho; a interface distingue simulação de operação real.
- Limites: sem contas, backend, renderização, exportação de vídeo, IA, conexão social ou cobrança. Vídeos não são persistidos, apenas os metadados do rascunho. Não existe sincronização entre dispositivos.

### 2. MVP funcional — implementada localmente

Entrega v0.2: contas, uploads privados, corte, enquadramento, composição de headline, fila FFmpeg e download MP4 nas três proporções. Ver [guia operacional](MVP.md) para os limites e verificações. A implantação pública continua na etapa 3. Para execução autônoma, SQLite e disco privado substituem nesta versão PostgreSQL/object storage; downloads passam pela sessão autenticada em vez de URLs externas assinadas. As exportações não têm cobrança nesta etapa.

Escopo originalmente definido:

Construir uma fatia vertical: cadastro → upload → composição → fila de render → download MP4. Autenticação, isolamento por workspace, banco persistente, armazenamento privado, URLs assinadas e limites de upload. Editor com corte, posição do texto, proporção e templates versionados. Worker de mídia separado executando FFmpeg; jobs idempotentes com progresso, cancelamento, retries limitados e contabilização somente conforme política explícita. Prévia e render devem usar a mesma especificação de composição.

Critérios: dois usuários não acessam arquivos um do outro; vídeo real gera MP4 reproduzível nas três proporções; reprocessamento não duplica a cobrança; falhas podem ser recuperadas; cotas e erros são visíveis; testes de integração cobrem upload, renderização e autorização.

### 3. Operação e lançamento — código integrado; ativação externa pendente

Entrega v0.3: telas de contas conectadas, publicações e planos; OAuth Instagram/YouTube; agendador persistente; Stripe; cotas; build Vercel e backend Docker. Ver [guia de deploy](DEPLOY-VERCEL.md) para configuração e pendências. A produção começa como beta por convite. Não houve publicação real em rede social, transação Stripe ou deploy remoto sem credenciais.

Começar por uma rede social via API oficial; ampliar conforme aprovação de apps e demanda. OAuth, tokens protegidos, calendário, fuso horário explícito, webhooks e prevenção de posts duplicados. Assinaturas, cotas claras, portal de cancelamento, eventos de uso, monitoramento, backups e documentação operacional. Landing page comercial com demonstração real, termos, privacidade e preços definidos após medir custos.

Critérios: pagamento de teste libera o plano correto; eventos duplicados não duplicam créditos; publicação de teste funciona em conta autorizada; renovação/revogação de tokens e falhas de publicação são tratadas; restauração de backup validada; acessibilidade e navegação móvel revisadas.

Dependências externas: escolha de infraestrutura, credenciais do provedor de pagamentos e aprovação das APIs sociais. São dependências de lançamento, não razões para antecipar essas integrações na etapa 1.

## Arquitetura proposta para o MVP

Frontend web → API autenticada → PostgreSQL + armazenamento de objetos privado.
API → fila de jobs → worker FFmpeg → arquivo final no armazenamento → download autorizado.
Agendador → adaptadores das APIs sociais; webhooks de pagamento → ledger de assinatura/cotas.

Entidades: User, Workspace, Membership, Asset, Project, CompositionVersion, RenderJob, SocialConnection, ScheduledPost, Subscription e UsageEvent. Cada recurso pertence a um workspace. Datas persistidas em UTC, exibidas no fuso configurado pelo usuário. Nenhuma credencial social deve existir no frontend.

Decisão desta etapa: HTML/CSS/JS sem dependências de runtime para validar experiência rapidamente. O protótipo é especificação navegável; migrar os componentes para o frontend do MVP quando o backend for implementado. Renderização pesada não deve rodar em um Worker de hospedagem de páginas; precisa de worker de mídia dedicado.

## Priorização

Primeiro valor: transformar um vídeo próprio em variações revisáveis e exportáveis. Scraping, repostagem em massa, biblioteca de vídeos de terceiros, formação e controle por agentes ficam fora do MVP inicial. Paridade com toda a oferta anunciada pelo concorrente não é critério de lançamento. Reavaliar após validação de uso e demanda.

Métricas propostas: tempo até primeira exportação, conclusão do primeiro projeto, falhas de renderização, custo por minuto renderizado e criadores ativos por semana.

## Ampliação autorizada em 22/10/2026

A pedido do founder, antecipamos coleta de referências de sites/RSS/Atom e redes sociais (Instagram primeiro, TikTok em seguida), biblioteca privada e criação de rascunhos. A coleta guarda metadados e origem; não baixa vídeos de terceiros. Entregamos também a apresentação pública `/sobre` e métricas de uso/exportações/falhas por conta. Custos, criadores ativos e funil de ativação continuam pendentes. Ver [limites, configuração e testes](COLETA-METRICAS.md). Ativação externa e abertura pública continuam pendentes.
