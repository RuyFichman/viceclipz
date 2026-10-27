# Deploy do ViceClipz — etapa 3

Código preparado para **beta por convite**. O deploy remoto não foi executado: faltam domínio/URL estável, servidor persistente e credenciais. Não há cobrança nem publicação social real ativada localmente.

## Arquitetura

Navegador → Vercel (interface) → proxy `/api/*` → backend HTTPS persistente (API, SQLite, arquivos, worker FFmpeg e agendador).

A Vercel serve a interface e encaminha a API. Não usamos Functions para vídeos: o limite de payload é 4,5 MB e elas não mantêm nossos processos residentes/disco SQLite. O proxy externo tem timeout de 120 segundos: uploads lentos de 100 MB precisam ser validados no destino. Se afetar o beta, migrar para upload direto em object storage com URLs assinadas. Referências oficiais: [Functions](https://vercel.com/docs/functions/limitations), [rewrites](https://vercel.com/docs/routing/rewrites), [timeout](https://vercel.com/docs/errors/router_external_target_error).

Manter **uma réplica** do backend, sem autosleep, com volume persistente. O `server.lock` impede duas instâncias no mesmo DATA_DIR. O agendamento funciona com o navegador fechado enquanto o servidor permanece ligado.

## Servidor persistente

Pode ser uma VPS com Docker/Compose. Comprar domínio na Hostinger não obriga hospedar nela. Aponte um subdomínio, como `api.seudominio.com`, para a VPS. Exponha 80/443, não a porta interna 4173.

1. Crie `.env` a partir de `.env.example`. Nunca envie o arquivo ao Git.
2. Defina APP_ORIGIN como a URL HTTPS estável da interface, sem barra final. Pode começar com a URL de produção `*.vercel.app` e migrar depois para o domínio comprado.
3. Defina BACKEND_HOST=api.seudominio.com e BACKEND_ORIGIN=https://api.seudominio.com.
4. Gere TOKEN_ENCRYPTION_KEY com o comando do exemplo e guarde uma cópia protegida. Sem ela os tokens sociais e checkpoints não podem ser decifrados. Não a troque sem reconectar as contas.
5. Mantenha BILLING_REQUIRED=true. Cadastros em produção exigem e-mail em BETA_EMAILS, separados por vírgula. Lista vazia fecha novos cadastros. Configure RESEND_API_KEY e EMAIL_FROM conforme o [guia de contas](CONTAS-EMAIL.md): contas novas e antigas precisam confirmar o e-mail para acessar o estúdio. Sem configuração de envio, o backend de produção não inicia.
6. Execute `docker compose -f compose.production.yaml up -d --build`. O Caddy provisiona HTTPS quando o DNS estiver correto.
7. Confira `/api/health`: worker e automation precisam estar true. Configure monitor externo para alertar indisponibilidade e monitore disco livre.

O Compose limita o serviço a 2 GB e 2 CPUs como ponto de partida, ainda sem teste de carga. As cotas por usuário não substituem monitorar o espaço global do volume.

### VPS compartilhada com proxy existente

Quando outro proxy (por exemplo Nginx Proxy Manager) já ocupa 80/443, use `compose.vps.yaml` em vez de `compose.production.yaml`. Ele sobe só o estúdio, sem portas publicadas e sem Caddy, na rede Docker externa do proxy (`PROXY_NETWORK`, padrão `apps`), com limite de 0,9 CPU e 1200 MB para caber em VPS de 1 vCPU.

1. Interface e API podem ficar no mesmo host, sem Vercel: use o mesmo nome em APP_ORIGIN (`https://host`) e BACKEND_HOST (`host`).
2. `docker compose -f compose.vps.yaml up -d --build`.
3. No proxy, crie um host para esse nome apontando para `viceclipz:4173` (HTTP), com certificado Let's Encrypt, HTTPS forçado e, na configuração avançada, `client_max_body_size 105m;`, `proxy_read_timeout 300s;` e `proxy_send_timeout 300s;`.
4. Atualizações: `npm run deploy:vps -- usuario@host --key CAMINHO_DA_CHAVE`. O script envia o commit atual (não as alterações sem commit) para `~/viceclipz.next`, copia o `.env` do servidor, constrói a imagem com o contêiner antigo ainda no ar, troca as pastas, aguarda o healthcheck e confere `/api/health` pela URL pública. A versão anterior fica em `~/viceclipz.prev`; `npm run deploy:vps -- usuario@host --rollback` volta para ela mantendo o `.env` atual.

Limitação: atrás do proxy o servidor vê o IP do proxy, então os limites de login e de ações de conta por IP passam a ser compartilhados por todos os usuários. Aceitável para um beta pequeno por convite; antes de abrir ao público, defina uma fronteira de proxy confiável para ler o IP real.

## Vercel

Importe o repositório e escolha **viceclipz-studio** como Root Directory se estiver dentro do repositório pai. Framework: **Other**. O vercel.json define instalação sem dependências e `node build-vercel.mjs` como build. Não use npm start nem crie Function para o backend.

Configure **somente BACKEND_ORIGIN** na Vercel. O build gera `.vercel/output` com arquivos públicos selecionados e proxy externo `/api/*`, conforme a [Build Output API v3](https://vercel.com/docs/build-output-api/configuration). Chaves Stripe/Google/Instagram ficam apenas no backend. O build recusa origem ausente, HTTP ou com caminho/credenciais.

Não conecte Preview Deployments ao backend de produção: use staging com APP_ORIGIN próprio, ou deixe BACKEND_ORIGIN indisponível no escopo Preview. OAuth e CSRF exigem origem estável e exata.

Após o deploy, adicione o domínio no painel Vercel e configure os registros DNS indicados por ela na Hostinger. Mudanças no domínio exigem atualizar APP_ORIGIN, callbacks OAuth e webhook Stripe.

## Instagram, primeira rede

Configure um app Meta com Instagram Login e uma conta profissional de teste. No backend: INSTAGRAM_CLIENT_ID, INSTAGRAM_CLIENT_SECRET e META_API_VERSION com a versão suportada pelo seu app.

- Callback: `APP_ORIGIN/api/social/callback/instagram`.
- Permissões: instagram_business_basic e instagram_business_content_publish.
- Para usuários fora dos papéis de teste, concluir revisão/acesso exigidos pelo Meta e fornecer URLs de privacidade/exclusão solicitadas no painel.
- Na interface: Contas conectadas → Conectar Instagram. Tokens ficam cifrados em AES-256-GCM.
- Exporte em 9:16, mínimo 3 segundos. Clique Agendar, confira conta, legenda e horário. O backend cria o container, aguarda processamento e publica o Reel.

A mídia usa URL assinada válida por uma hora e acessível somente durante preparação/envio. O provedor precisa acessá-la sem sessão e sem bloqueio por Deployment Protection da Vercel.

YouTube é opcional no primeiro lançamento. Configure GOOGLE_CLIENT_ID/SECRET, YouTube Data API e callback `APP_ORIGIN/api/social/callback/youtube`. Valide verificação/auditoria e restrições de visibilidade antes de disponibilizar publicamente.

## Stripe

Comece em modo de teste. Crie dois preços **recorrentes mensais**, Creator e Studio. Os valores comerciais são definidos por você no Stripe; não há preços inventados no aplicativo.

- Configure STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET e os dois STRIPE_*_PRICE_ID no backend.
- Webhook: `APP_ORIGIN/api/billing/webhook`. Eventos: checkout.session.completed, customer.subscription.created/updated/deleted, invoice.paid e invoice.payment_failed.
- Ative o Customer Portal com cancelamento e troca entre os preços cadastrados.
- Cadastre cada preço como recorrente, mensal e ativo (preços de lançamento: Creator R$ 49 e Studio R$ 99). Seu plano exibe o valor lido do Stripe (cache de 10 minutos; 1 minuto após falha) e, sem resposta válida, mostra "O preço aparece no checkout seguro do Stripe". O valor nunca fica no código. A tela resume o uso do mês e o armazenamento com barras, a renovação da cota (dia 1º do mês seguinte, em UTC) e o status da assinatura em português (com a data de término quando o cancelamento está agendado); os três planos aparecem lado a lado com exportações, armazenamento e publicação agendada, o plano atual é marcado no próprio cartão, o Creator leva só o selo "Recomendado" e todo botão indisponível diz o motivo ao lado (cobrança não configurada, assinatura existente que deve ser gerenciada no portal, modo de teste). Assinar abre o checkout com preço/moeda antes da confirmação. Acesso só é concedido após webhook assinado e consulta da assinatura atual.
- Valide assinatura, cancelamento, renovação e pagamento recusado em teste. Depois configure preços, chaves e webhook live, sem misturar ambientes.

Grátis: 10 exportações/mês, 2 GB, sem redes. Creator: 100/mês, 2 GB e redes. Studio: 500/mês, 5 GB e redes. A cota renova por mês-calendário UTC. Falhas/cancelamentos liberam reserva; MP4 concluído conta mesmo apagado. Retry do mesmo job não duplica o ledger. Assinatura expirada, preço desconhecido ou status fora de active/trialing retorna ao grátis. Downgrade não apaga arquivos existentes.

## Operação e backup

- `needs_review`: confira diretamente na rede e marque o resultado pela interface. Timeout pode ocorrer após publicação; não há retry automático desse envio.
- Atraso superior a 24h falha para evitar envio muito tardio. Preparação: até três tentativas. Processamento na rede: até uma hora.
- Desconectar cancela envios ainda não iniciados e apaga token local. Revogue também o aplicativo nas configurações da rede quando necessário.
- Webhooks persistem antes da resposta 200. Falhas de reconciliação têm retries; inspecione billing_events com state=failed. Após corrigir a causa, um operador pode recolocá-los em pending com attempts=0,next_run=0. Nunca conceder plano a partir de redirect do checkout.
- Pare servidor e workers antes do backup. `node backup.mjs create ORIGEM DESTINO_NOVO` valida SQLite e grava manifesto SHA-256. `node backup.mjs restore BACKUP DESTINO_NOVO` valida hashes e restaura sem sobrescrever pastas. Aponte DATA_DIR ao diretório restaurado e reinicie. No Docker, monte o volume parado em um contêiner de manutenção. Copie backups para armazenamento externo protegido e guarde a chave de cifragem separadamente. Não copie só o SQLite com o servidor ligado.

## Antes do lançamento público

Este pacote prepara o beta; **não declara o lançamento público concluído**. Pendências:

- Smoke test pela URL Vercel: cadastro convidado, login, upload acima de 4,5 MB, MP4, download/range, OAuth, publicação real em conta de teste e assinatura Stripe de teste.
- Aprovação Meta (Google se ativado), callbacks e webhooks acessíveis sem Deployment Protection.
- Revisão jurídica e preenchimento das minutas `/termos`, `/privacidade`, `/retencao` e `/suporte` (campos entre colchetes; ver [pendências jurídicas](JURIDICO.md)). A exclusão de conta pelo titular está implementada; a URL de instruções de exclusão para a Meta é `APP_ORIGIN/privacidade#exclusao`.
- Validar a entrega real de e-mail e os fluxos de confirmação/recuperação na URL pública. A implementação e os testes locais estão no [guia de contas](CONTAS-EMAIL.md); domínio de envio e credenciais ainda exigem configuração.
- Backups externos e restauração ensaiada no servidor de destino; monitoramento de saúde, espaço e falhas.

Testes automatizados usam provedores simulados. Cobrem nossa lógica, não comprovam aprovação de apps, credenciais, publicação real ou cobrança real.
