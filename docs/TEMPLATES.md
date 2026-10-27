# Templates e variações em lote

O editor de templates substitui a criação de projetos com headline em faixa. Ele gera vídeos verticais 9:16 (720 × 1280) com cartão de perfil, frases, zonas de mídia empilhadas e quantas variações couberem no lote. Projetos antigos continuam abrindo no editor clássico, com os mesmos dados, exportações e regras.

## Fluxo

1. **Galeria** (`#templates`): Post card, Meme e Vídeo viral. "Usar este template" cria o template na conta e abre o editor em `#builder/<id>`.
2. **Perfil**: avatar (envio ou biblioteca), selo de verificado (círculo com check branco, no azul #1D9BF0 do X), nome, @, alinhamento, tema claro/escuro, posição (texto ↑ · perfil ↓ ou o inverso) e tamanhos em pixels de saída. "Salvar perfil" grava um perfil reutilizável; "Escolher perfil salvo" aplica uma cópia.
3. **Zonas**: até 4 zonas, cada uma com uma área ou duas lado a lado; tipo (vídeo ou imagem), enquadramento (preencher ou mostrar inteiro) e altura relativa. Modelos prontos: 1 vídeo, 1 vídeo com fundo blur, 2 vídeos empilhados, imagem fixa + vídeo, vídeo + 2 imagens. Reordenação por arrastar ou pelos botões ↑/↓.
4. **Frases**: até 50 frases de até 280 caracteres e 8 linhas. Geração automática opcional (marcada como AUTO) e escrita manual.
5. **Mídia**: até 20 opções por área. Cada vídeo tem corte, zoom (1–3×) e posição horizontal/vertical (0–100%); imagens têm zoom e posição.
6. **Estilo**: fonte (Inter Bold, Inter Black, Montserrat ExtraBold, Anton, Bebas Neue), cor, contorno, tamanho, margem lateral e espaçamento externo. A prévia repete os 3 primeiros segundos do corte.
7. **Variações**: seleção de opções por área e de frases. Total = produto das opções selecionadas em cada área × frases selecionadas.
8. **Gerar**: cria o lote, mostra fila, progresso, prévia, download, cancelamento e nova tentativa por item ou do lote, e "Baixar todas (ZIP)".

As etapas Variações e Gerar ficam bloqueadas, com o motivo visível, até existir vídeo, mídia em todas as áreas e frases. O editor salva automaticamente 1,5 s depois da última alteração e também em "Salvar … e continuar". Conflitos entre abas são recusados pela revisão do projeto.

## Prévia e exportação

O servidor desenha o cartão e as faixas (`lib/template-render.mjs`) e devolve o PNG com a geometria exata das faixas e células. A prévia posiciona `<video>`/`<img>` nessas células usando `placement()` de `dist/template-core.js`, a mesma função que calcula o recorte enviado ao FFmpeg. O fundo blur da prévia usa um canvas 90 × 160 ampliado com desfoque equivalente ao `boxblur` da exportação; é uma aproximação visual, não um quadro idêntico.

Regras de composição:

- As faixas ocupam no máximo 60% da altura. Se a frase não couber, o tamanho diminui até 16 px e as linhas excedentes terminam em reticências.
- As zonas dividem o espaço livre na proporção das alturas relativas; as dimensões são sempre pares.
- **Vídeo principal**: a primeira área de vídeo, de cima para baixo e da esquerda para a direita. O corte dele define a duração do MP4 (0,25–120 s) e somente o áudio dele é usado (ou nenhum, com "Remover o áudio").
- Vídeos secundários começam no início do próprio corte; se forem mais curtos que o principal, congelam no último quadro; se forem mais longos, são cortados.
- Imagens ficam estáticas durante toda a duração.
- No fundo blur, as faixas ficam translúcidas sobre o vídeo principal desfocado e as áreas em "mostrar inteiro" deixam o blur visível.
- Um template precisa de ao menos uma área de vídeo para gerar variações.

O filtergraph de cada variação recorta cada fonte no espaço original antes de escalar (mais barato em 1 vCPU), usa `hstack` para áreas lado a lado, `vstack` para zonas contíguas, `overlay` sobre fundo preto ou blur e, por fim, o PNG do cartão. Mantém `-threads 2`, `-filter_complex_threads 1`, tempo limite de 15 s por segundo de saída (mínimo 90 s), cancelamento, limpeza de temporários e validação do MP4 (duração ±0,3 s, 720 × 1280, H.264, tamanho dentro da reserva).

## Imagens

PNG, JPEG e WebP são aceitos no mesmo upload de vídeos (100 MiB, cota de armazenamento do plano). O tipo é reconhecido pelo conteúdo (assinatura + ffprobe), não pela extensão. Imagens acima de 8192 × 8192 ou 50 megapixels são recusadas. Cada imagem é decodificada e regravada sem metadados (EXIF, localização, comentários, ICC), com a orientação EXIF aplicada e lado maior de até 2160 px: JPEG quando opaca, PNG quando há transparência. Imagens animadas viram estáticas (primeiro quadro). O conteúdo privado continua exigindo sessão do titular e aceita HTTP Range.

## Lotes, fila e cotas

- Até 50 variações por lote. O lote é **uma operação**: o limite de duas operações ativas por conta conta exportações avulsas e lotes, não os itens.
- Antes do botão, a etapa Gerar diz quanto o lote consome ("Este lote usa N das suas M exportações restantes neste mês") ou por que o botão está desativado (mais de 50 variações, ou cota insuficiente, com link para Seu plano). O servidor continua sendo quem confere a cota.
- Cada item é um registro em `jobs` com `batch_id` e reserva **uma exportação** do mês no ledger existente. Falhas e cancelamentos liberam a reserva; nova tentativa reserva o mesmo item de novo (chave por job, sem contagem dupla); remover itens concluídos não devolve o uso.
- Armazenamento: cada item reserva o tamanho máximo pelo bitrate (≈ 600 kB por segundo + 4 MiB, até 100 MiB); exportações avulsas continuam reservando 100 MiB.
- O worker global renderiza um job por vez. A fila intercala contas (o item mais antigo de cada conta primeiro), então um lote grande não bloqueia as exportações de outras pessoas.
- Posição e estimativa: a posição considera a fila global; a estimativa usa o tempo real de renderização por segundo de saída das últimas 20 renderizações deste servidor e não aparece antes da primeira.
- Criar lote exige a revisão atual do template e uma chave de requisição (`requestKey`), que torna o pedido idempotente. Os snapshots das variações ficam congelados no momento da criação.
- O ZIP é transmitido sem compressão (MP4 já é comprimido), um arquivo por vez, com CRC calculado pelo worker ao concluir cada item. Limite de 4 GiB por ZIP; um download simultâneo por conta.
- Itens concluídos aparecem também em Exportações e podem ser agendados como qualquer MP4 9:16.

## Frases automáticas

`lib/phrase-ai.mjs` é um adaptador para a Messages API da Anthropic (SDK oficial `@anthropic-ai/sdk`), configurado somente no backend:

| Variável                  | Uso                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | Habilita a geração. Sem ela, a etapa Frases explica que a geração está indisponível e a escrita manual continua funcionando. |
| `PHRASE_AI_MODEL`         | Modelo; vazio usa `claude-opus-5-5`.                                                                                         |
| `PHRASE_AI_MONTHLY_LIMIT` | Gerações bem-sucedidas por conta e mês UTC (padrão 60).                                                                      |

O pedido usa saída estruturada (`output_config.format` com JSON Schema), esforço `low` e, nos modelos que aceitam, fallback de recusa no servidor (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). O prompt exige frases curtas em pt-BR, fiéis à descrição, sem fatos inventados, hashtags ou emojis, e trata a descrição como dado. A resposta é validada: textos de uma linha, até 280 caracteres, sem aspas externas, sem duplicatas, no máximo a quantidade pedida. Uma recusa vira mensagem clara (422). Limites: descrição de 10 a 1000 caracteres, 1 a 10 sugestões, uma geração a cada 15 s por conta, até 3 gerações simultâneas no servidor. Os logs registram apenas classe e status do erro, nunca a descrição, as frases ou a chave. Os testes usam provedor simulado e nunca chamam a API real.

## Dados e migração

Mudanças aditivas e repetíveis em `lib/db.mjs` (`PRAGMA user_version=2`):

| Tabela                           | Conteúdo                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `projects`                       | Templates são projetos com `data.kind = "template"` e `version: 2` (perfil, estilo, zonas, mídias por área, frases, seleção). |
| `asset_kinds`                    | Tipo (`image`) e MIME de cada imagem. Arquivos sem linha aqui são vídeos; `assets` mantém as colunas originais.               |
| `jobs`                           | Novas colunas `batch_id`, `item_index`, `reserve`, `started`, `crc`.                                                          |
| `batches`                        | Lote por template, revisão de origem, total e `request_key` única por conta.                                                  |
| `saved_profiles`, `saved_styles` | Até 20 itens por conta, nome único por conta; salvar com o mesmo nome substitui.                                              |
| `ai_requests`                    | Uma linha por geração automática bem-sucedida, por mês UTC.                                                                   |

Bancos anteriores ganham tabelas e colunas na primeira inicialização, sem reescrever tabelas existentes. `assets` não muda porque a versão anterior insere nela por posição: um `deploy-vps.mjs --rollback` depois da migração continua aceitando uploads e projetos clássicos. Na versão anterior, imagens aparecem como vídeos inutilizáveis (a renderização falha com mensagem genérica), itens de lote falham se forem processados e templates com lotes não podem ser removidos por ela. Inserções em `jobs` precisam listar as colunas, como o código já faz. Faça backup offline antes de atualizar a produção (`node backup.mjs create ...`) e teste a atualização numa cópia restaurada.

Arquivos referenciados por projetos, templates, perfis salvos (avatar) ou renderizações ativas não podem ser removidos. Remover um template remove seus lotes e MP4 gerados; publicações agendadas bloqueiam a remoção.

## API

Todas exigem sessão, e as mutações exigem `X-ViceClipz: studio` e origem válida.

| Método e rota                                          | Uso                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `POST/PUT /api/projects[/:id]` com `kind: "template"`  | Cria ou salva o template (até 256 KiB, revisão obrigatória no PUT).              |
| `POST /api/templates/preview`                          | PNG do cartão e geometria das faixas e células.                                  |
| `GET /api/templates/limits`                            | Limite do lote, uso do mês, operações ativas e estado da geração automática.     |
| `GET/POST /api/profiles`, `DELETE /api/profiles/:id`   | Perfis salvos.                                                                   |
| `GET/POST /api/styles`, `DELETE /api/styles/:id`       | Estilos salvos.                                                                  |
| `POST /api/phrases/generate`                           | Sugestões automáticas (`description`, `count`).                                  |
| `POST /api/templates/:id/batches`                      | Cria o lote (`requestKey`, `revision`).                                          |
| `GET /api/batches?projectId=` · `GET /api/batches/:id` | Lotes e itens com posição e estimativa.                                          |
| `POST /api/batches/:id/cancel` · `/retry`              | Cancela itens pendentes; repete falhos e cancelados (até 3 tentativas por item). |
| `GET /api/batches/:id/archive`                         | ZIP das variações prontas.                                                       |
| `DELETE /api/batches/:id`                              | Remove lote sem itens ativos ou publicações.                                     |
| `GET /api/jobs/:id/download?inline=1`                  | MP4 para a prévia, sem forçar download.                                          |

## Limitações conhecidas

- Somente 9:16. O modelo guarda o formato para permitir 1:1 e 4:5 depois.
- As fontes não incluem emoji; caracteres sem glifo aparecem como caixas no MP4.
- O desfoque da prévia é aproximado; a geometria das faixas, células, zoom e posição coincide com a exportação.
- O tempo de renderização no VPS de produção (1 vCPU) não foi medido para lotes; a estimativa só aparece depois de renderizações reais no servidor.
- A geração automática não foi validada contra a API real nesta entrega; apenas o adaptador com provedor simulado.
- Prévia de MOV/WebM depende dos codecs do navegador, como no editor clássico.

## Verificação

`node --test tests/templates.test.mjs` cobre migração de banco anterior, validação, geometria e filtergraph, cotas do lote, perfis/estilos salvos e o adaptador de frases simulado. `node --test tests/template-render.test.mjs` (porta 4188) envia vídeos e imagens sintéticos, renderiza cada modelo pronto com FFmpeg real e confere dimensões, duração, streams, cores de faixas e células, lotes, cotas, ZIP e proteção de arquivos.
