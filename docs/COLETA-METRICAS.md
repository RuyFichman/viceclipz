# Coleta, métricas e apresentação — 22/10/2026

Três entregas solicitadas: coleta de sites/redes, painel de métricas e apresentação pública. Não abre o cadastro de produção nem ativa serviços externos.

## Coleta de referências

**Descobrir conteúdo** aceita páginas HTML, feeds RSS/Atom e links completos de publicações públicas. Guarda título (160 caracteres), trecho (300), autoria (100) e origem. Até 200 referências por conta, deduplicação por URL, exclusão e criação de rascunhos. O rascunho começa sem vídeo/headline; o criador envia conteúdo autorizado e escreve seu texto. Fonte e autoria ficam na biblioteca, não são copiadas para o MP4.

- Sites: HTML/OpenGraph e até 20 entradas por feed. Sem JavaScript, crawl recursivo, cookies, login ou bypass.
- Instagram primeiro: `/p/…`, `/reel/…`, `/tv/…` via `graph.facebook.com/{META_API_VERSION}/instagram_oembed`. Configure a versão suportada pelo app. `META_OEMBED_ACCESS_TOKEN` é opcional e exclusivo do backend, enviado em Authorization quando configurado. Requisitos e disponibilidade precisam ser verificados no painel Meta. A [documentação oficial](https://developers.facebook.com/documentation/instagram-platform/oembed) estava inacessível à pesquisa nesta execução; não houve consulta real de uma publicação autorizada.
- TikTok em seguida: `/@criador/video/ID` via `https://www.tiktok.com/oembed`. Contrato confirmado na [documentação oficial](https://developers.tiktok.com/docs/en/embed-videos). Sem links curtos, perfis ou publicação TikTok.
- Somente metadados; nenhum download de vídeos sociais, execução de embed ou disparo de publicação.

API: `GET/POST /api/discovery` (POST recebe `{ "url": "https://…" }`); `DELETE /api/discovery/:id`; `POST /api/discovery/:id/project`. Sessão, titularidade, confirmação de e-mail e CSRF preservados.

## Segurança e limites

HTTPS/443, sem credenciais na URL ou IPv6 literal. DNS resolve todos os endereços, rejeita privados/reservados e fixa o IP validado na conexão TLS, preservando hostname/certificado. Cada redirecionamento de site repete as verificações e robots.txt, no máximo três. APIs oficiais não seguem redirecionamentos nem repassam credenciais. Robots: 404 permite; bloqueios, erros ou redirects interrompem. APIs oficiais não consultam robots.

Até 2 MiB/resposta, timeout de DNS 5 s e de conexão/resposta 10 s; sem compressão. User-Agent `ViceClipzBot/1.0`. Uma coleta por conta, quatro simultâneas no processo, intervalo de cinco segundos por conta e aproximadamente um segundo por host, persistido em SQLite. Sites que exigem JavaScript ou bloqueiam robôs podem não funcionar; a interface informa a falha.

## Métricas e apresentação

`GET /api/metrics`: projetos, vídeos, referências, armazenamento, estados de exportações/publicações e tempo médio criação/conclusão, incluindo fila. Contagens e média usam registros mantidos. Histórico de 30 dias usa ledger de exportações concluídas, agrupado pela data de solicitação UTC; excluir arquivos não apaga esse histórico. Sem números de audiência, custos ou usuários ativos globais.

`/sobre` apresenta fluxo, limites, FAQ e entrada no estúdio. Sem preços inventados ou promessa de integração ativa. Build Vercel e allowlist local incluem os novos arquivos. Backend permanece persistente. Instalar com `npm ci` e reiniciar cria `discovery_items`/`discovery_limits` aditivamente; fazer backup offline antes de atualizar produção.

## Verificações

- `npm run check`: passou.
- `npm run build:vercel`: pacote gerado com backend ilustrativo; `git diff --check` sem erros. Prévia 4173 reiniciada e `/api/health` confirma workers de renderização e automação ativos.
- Consulta HTTPS real a `https://example.com/` passou por DNS fixado e robots.txt, retornando HTML com status 200. Isso não substitui validação externa dos provedores sociais.
- `npm test`: 50 testes, zero falhas, quatro arquivos. Contas/e-mail, MVP/MP4 real, integrações/cobrança/build/backup, coleta/métricas. Provedores simulados.
- MP4s de evidência: `test-results/8d9a5468-f54c-4c5e-8839-31400a74fba1/` (ignorado pelo Git).
- Navegador com banco/conta sintéticos na porta 4188: apresentação, login, biblioteca, URL privada rejeitada, rascunho criado e métricas mostrando o projeto. Viewport estreito inspecionado; screenshots `test-results/landing-growth.png` e `test-results/metrics-growth.png`.
- Nenhum e-mail, cobrança ou publicação real; nenhum deploy remoto. Validação externa da coleta social, termos/privacidade, domínio/remetente, suporte e infraestrutura permanecem pendentes.
