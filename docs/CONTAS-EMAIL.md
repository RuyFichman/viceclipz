# Verificação de e-mail e recuperação de senha

Implementado em 22/10/2026. O envio usa a API HTTPS do Resend, sem adicionar dependências. O código e os testes estão prontos; a entrega real exige configurar domínio/remetente e credenciais.

## Configuração

No backend, configure:

```dotenv
RESEND_API_KEY=<chave armazenada como segredo no servidor>
EMAIL_FROM=ViceClipz <contas@seudominio.com>
TOKEN_ENCRYPTION_KEY=<a mesma chave hexadecimal de 32 bytes usada pelo backend>
APP_ORIGIN=https://seu-studio.vercel.app
EMAIL_VERIFICATION_REQUIRED=true
```

Verifique o domínio de envio e os registros DNS solicitados no painel Resend. Use uma chave com permissão de envio adequada. Não configure essas chaves na Vercel nem em código frontend. Referência: [API de envio Resend](https://resend.com/docs/api-reference/emails/send-email).

APP_ORIGIN deve ser a origem HTTPS pública exata do estúdio, sem caminho ou barra final. Os links são construídos a partir dessa configuração, nunca a partir de Host ou de um parâmetro enviado pelo cliente. Desative rastreamento de cliques no provedor para mensagens de autenticação e confira que o cliente de e-mail preserva o fragmento do link.

`npm run dev` não lê `.env` automaticamente. Use variáveis do processo ou `node --env-file=.env server.mjs`; Compose já usa seu env_file. Um arquivo de produção contém caminhos/hosts próprios do contêiner: adapte-os para execução local.

Em produção, a verificação é sempre obrigatória e o servidor recusa inicializar sem RESEND_API_KEY, EMAIL_FROM e chave de cifragem válidos. EMAIL_VERIFICATION_REQUIRED=false não desativa a proteção em produção. Em desenvolvimento, ela também é ativada quando o e-mail está configurado ou quando EMAIL_VERIFICATION_REQUIRED=true. Sem configuração e sem essa opção, o estúdio local continua funcionando; recuperação informa indisponibilidade, sem simular envio.

O beta por convite permanece ativo: BETA_EMAILS continua restringindo novos cadastros em produção. Essa entrega não abre automaticamente o cadastro público.

## Fluxos

**Cadastro:** cria uma conta não verificada e uma sessão limitada, enfileira a mensagem e mostra a tela de confirmação. Essa sessão acessa somente o estado da conta, reenvio, logout e exclusão da conta; assets, projetos, exportações, integrações, agendamentos e cobrança ficam bloqueados enquanto a verificação for exigida.

**Confirmação:** o link abre um formulário e o usuário precisa clicar em Confirmar meu e-mail. GET/navegação não consomem o token, evitando confirmação automática por scanners. A conclusão marca o e-mail como verificado, invalida links de conta e sessões/OAuth pendentes, e exige novo login.

**Reenvio:** disponível na tela de conta não verificada, com intervalo de um minuto. O novo link invalida o anterior. Se uma mensagem antiga já estiver em trânsito, ela pode chegar, mas seu token não funcionará.

**Recuperação:** Esqueci minha senha aceita um e-mail e responde com a mesma mensagem para contas existentes, desconhecidas ou com limite de envio excedido. A senha e as sessões não mudam durante a solicitação. O novo link de recuperação substitui o anterior. Após informar uma senha válida pelo link, a transação altera o hash, marca a posse do e-mail como confirmada, invalida todos os links/sessões da conta e estados OAuth pendentes. Não há login automático.

Dados, projetos, arquivos e assinaturas são preservados. A redefinição não remove conexões sociais nem cancela publicações já agendadas; tokens de provedores têm ciclo próprio.

## Exclusão de conta

`POST /api/auth/delete-account` com `{ password, confirm: "EXCLUIR" }`, disponível em Sua conta e, para contas não verificadas, na tela de confirmação. Exige a senha atual e as verificações de origem/CSRF; 10 tentativas por conta em 15 minutos.

- **Bloqueios (409):** assinatura cobrável sem cancelamento ao fim do período (active, trialing, past_due, unpaid, paused, incomplete); publicação em `preparing`/`publishing`, cuja mídia ainda pode ser lida pelo provedor; upload em andamento.
- **Exportações:** na mesma transação, exportações na fila são canceladas (reserva liberada) e as em execução passam a `cancelling`. A resposta pede nova tentativa em alguns segundos, depois que o worker confirmar o cancelamento. Nada é apagado enquanto houver render ativo.
- **Remoção:** uma transação apaga as linhas de todas as tabelas com `user_id` (lista fixa em `lib/account-deletion.mjs`), `asset_kinds` em cascata, os `billing_events` que citam o cliente Stripe e o usuário. Depois do commit, os arquivos de mídia e MP4 são removidos e o cookie é limpo. Falhas ao apagar arquivos são registradas apenas como contagem.
- **Fora do servidor:** o cliente e o histórico de pagamento continuam no Stripe; eventos posteriores de uma assinatura cuja conta foi excluída são ignorados pela reconciliação. Publicações feitas continuam nas redes e a autorização do app deve ser revogada pelo titular na rede. Backups mantêm os dados até o fim do ciclo de retenção.
- Ao adicionar uma tabela com `user_id`, inclua-a em `OWNED_TABLES`. O teste de exclusão em `tests/launch.test.mjs` percorre todas as tabelas com essa coluna e falha se alguma mantiver linhas do titular.
- O histórico de cotas é apagado junto: um mesmo e-mail cadastrado de novo começa com cota zerada.

## Proteções e armazenamento

- Tokens aleatórios de 32 bytes; confirmação expira em 24h, recuperação em 30 minutos.
- Somente o digest SHA-256 é usado para validar o token no banco. O texto da mensagem pendente, incluindo o link, fica cifrado em AES-256-GCM com TOKEN_ENCRYPTION_KEY.
- Tokens são de uso único. Transações SQLite e nova validação após o scrypt impedem duas redefinições simultâneas com o mesmo link.
- A senha mantém o padrão existente: 10–128 caracteres e hash scrypt com salt. Login revalida o hash persistido depois da comparação para não emitir sessão baseada em uma senha redefinida durante a operação.
- Links usam fragmento (`#verify-email?token=...` / `#reset-password?token=...`), que não é enviado na navegação HTTP. A interface remove esse fragmento do histórico atual e conserva o token apenas em memória até concluir/fechar. Ele é enviado no corpo de um POST com as verificações de origem/CSRF existentes.
- Recuperação tem resposta mínima de 200ms para reduzir diferenças triviais de tempo, limite de 3 envios por endereço em 15 minutos e 30 tentativas por IP de conexão em 15 minutos. Não bloqueia a conta nem invalida sessões por simples solicitação.
- Os limites persistem no SQLite com chaves derivadas por hash. Atrás de proxies, o IP de conexão pode ser compartilhado: validar a capacidade do beta antes de ampliar tráfego; não confiar arbitrariamente em X-Forwarded-For.
- Nunca registrar links, senhas, corpos de mensagens, tokens ou chaves em logs. Não expor a fila em endpoints públicos.

## Fila e operação

O worker de automação processa uma mensagem por ciclo, com timeout de 15s na chamada ao provedor e até cinco tentativas com espera crescente. Usa a mesma chave de idempotência em todas as tentativas. Mensagens em envio voltam à fila após reinício; mensagens expiradas ou cujos tokens foram invalidados são canceladas.

O payload cifrado é apagado quando enviado, cancelado ou ao esgotar tentativas. Metadados terminais são removidos após sete dias. Tokens expirados são limpos pelo worker. A aceitação pela API do Resend não comprova entrega na caixa de entrada; acompanhar entregabilidade, rejeições e supressões no provedor.

Para observar a fila sem expor conteúdo, um operador pode consultar:

```sql
SELECT state, count(*) AS total FROM account_mail GROUP BY state;
```

Se houver falhas, confira remetente, domínio, credenciais, cotas e disponibilidade do Resend. Após corrigir, solicite um novo link pela interface: o payload de uma mensagem definitivamente falha já foi removido. Não marque e-mails como verificados manualmente para contornar problemas de entrega.

## Atualização de uma instalação existente

Faça backup offline antes da atualização. A migração é aditiva: reutiliza account_tokens/verified_accounts e cria account_mail/account_rate_limits e índices, sem alterar ou apagar registros de usuários. Contas antigas não são marcadas como verificadas automaticamente. Quando a exigência estiver ativa, seus titulares entram com a senha atual e solicitam a confirmação na nova tela; sessões antigas também passam pelo bloqueio de API. Planeje comunicar essa mudança aos usuários antes de ativar em produção.

Preserve TOKEN_ENCRYPTION_KEY junto com os backups protegidos. Não a rotacione sem tratar também a fila cifrada e os tokens sociais. Nenhum envio é disparado em massa pela atualização: mensagens são criadas por cadastro, reenvio ou solicitação de recuperação.

## Validação executada

`npm run check` aprovado. `npm test`: **41 testes aprovados**, incluindo três agrupadores; 13 cenários novos de conta e toda a regressão anterior de mídia/integrações.

Cobertura: bloqueio de conta não verificada, confirmação explícita e replay, expiração e finalidade de token, reenvio/cooldown, resposta uniforme, troca de senha e invalidação de sessões/OAuth, corrida entre redefinições, contas legadas, recuperação da fila, retries limitados, contrato Resend, CSRF, limites persistentes e ausência de configuração.

UI inspecionada com conta fictícia em servidor isolado sem worker de envio: login limitado, confirmação por token de fixture, retorno ao login, formulário de recuperação/resposta genérica e campos de nova senha. A troca efetiva de senha foi validada via testes HTTP, sem preencher credenciais novas no navegador. Evidências ignoradas pelo Git: `test-results/email-verification.png` e `test-results/password-recovery.png`. MP4s da regressão: `test-results/c6a7c66b-9bc3-4a4c-8e98-f8123cf6426f/`.

Não houve envio real pelo Resend, teste de inbox/spam ou deploy remoto. Antes de ativar, testar uma conta autorizada pela URL pública, entrega real, confirmação em outro navegador, expiração, recuperação e invalidação das sessões. As demais pendências de lançamento continuam no [guia de deploy](DEPLOY-VERCEL.md).
