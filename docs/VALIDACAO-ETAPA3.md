# Validação da etapa 3 — 22/10/2026

`npm run check`: aprovado. `npm test`: **27 testes aprovados, zero falhas** (inclui dois testes agrupadores). Os testes usam bancos separados, sem alterar contas reais.

## Cobertura executada

- Regressão do MVP: contas/sessões/CSRF, isolamento entre usuários, uploads e range, revisões de projetos, MP4 H.264 real nas três proporções, áudio/silêncio, limites, cancelamento, retry, recuperação após reinício e remoção.
- Novos fluxos: cifragem e integridade de tokens, expiração de URLs assinadas, state/cookie OAuth e PKCE, isolamento e idempotência de agendamentos, horário, cancelamento, retries limitados e proteção contra duplicação após envio ambíguo/reinício.
- Stripe simulado: assinatura criptográfica de webhook, persistência/deduplicação, consulta do estado atual apesar de eventos fora de ordem, cancelamento/preço desconhecido, cotas, idempotência do checkout e isolamento do portal.
- Adaptador Instagram com respostas simuladas: preparação do container, URL assinada, processamento e publicação; refresh/revogação de token.
- Build Vercel: proxy HTTPS, rejeição de destino inválido e pacote apenas com arquivos públicos.
- Backup: restauração de banco e arquivo, rejeição de corrupção e de sobrescrita do destino.

MP4s da última execução: `test-results/862c18c1-daf2-437b-be70-da852a98997b/` (ignorado no Git).

## Interface

Inspeção no navegador em servidor isolado na porta 4188: login com conta fictícia, navegação entre Contas conectadas, Seu plano e Publicações, mensagens de configuração ausente e bloqueio de agendamento sem MP4. Layout corrigido para manter rodapé após o conteúdo e navegação lateral rolável. Evidência: `test-results/stage3-integrations.png`.

## Deploy

`docker compose --env-file .env.example -f compose.production.yaml config --no-env-resolution --quiet` validou a configuração. O Docker CLI mostrou avisos de acesso ao arquivo de configuração do usuário; nenhum contêiner foi construído/executado nesta validação. `git diff --check` não encontrou erros de whitespace.

Não foram executados: deploy remoto Vercel/VPS, teste de carga, publicação real Instagram/YouTube, transação Stripe real/teste na conta do titular, fluxo OAuth completo com credenciais, avaliação móvel em viewport dedicado ou restauração em VPS. Seguir os critérios de ativação no [guia de deploy](DEPLOY-VERCEL.md). O adaptador YouTube ainda precisa de validação externa específica antes de ser oferecido publicamente.
