# Pendências jurídicas das páginas públicas

Minutas criadas em 27/10/2026 para revisão por advogado. Elas descrevem o comportamento real do código nessa data e **não foram revisadas juridicamente**. Cada página exibe um aviso de minuta e marca em destaque os campos entre colchetes.

| Página | Arquivo | URL |
| --- | --- | --- |
| Termos de uso | `dist/termos.html` | `/termos` |
| Política de privacidade | `dist/privacidade.html` | `/privacidade` (exclusão em `#exclusao`) |
| Política de retenção | `dist/retencao.html` | `/retencao` |
| Suporte e contato | `dist/suporte.html` | `/suporte` |

Os links aparecem no cadastro, na tela de entrada, no rodapé do estúdio, em Sua conta, na página `/sobre` e no diálogo de exclusão de conta. Para a Meta, a URL de instruções de exclusão de dados é `APP_ORIGIN/privacidade#exclusao`, e a de política de privacidade é `APP_ORIGIN/privacidade`.

## Campos a preencher

- Identificação: `[RAZÃO SOCIAL]`, `[CNPJ]`, `[ENDEREÇO]`, `[FORO]`.
- Contato: `[E-MAIL DE SUPORTE]`, `[PRAZO DE RESPOSTA]`, `[NOME DO ENCARREGADO]`, `[E-MAIL DO ENCARREGADO]`.
- Regras comerciais: `[REGRA DE REEMBOLSO]` (inclui direito de arrependimento do art. 49 do CDC), `[IDADE MÍNIMA]`, `[PROCEDIMENTO E PRAZOS DE AVISO]` de suspensão, `[LIMITAÇÃO DE RESPONSABILIDADE]`, `[ANTECEDÊNCIA DO AVISO]` de mudanças.
- Dados: `[DETALHAR OBRIGAÇÕES]` legais, `[PROVEDOR E PAÍS DO SERVIDOR]`, `[MECANISMO DE TRANSFERÊNCIA APLICÁVEL]` (art. 33 da LGPD), `[REGRA PARA CONTAS INATIVAS]`, `[PRAZO DE GUARDA DOS REGISTROS DE ACESSO]`, `[PRAZO FISCAL APLICÁVEL]`, `[PRAZO DOS BACKUPS]`.
- `[DATA DE PUBLICAÇÃO]` em todas as páginas. Ao publicar a versão final, remova o aviso `legal-draft`.

## Questões para o jurídico

1. **Registros de acesso (Marco Civil, art. 15).** Provedor de aplicação constituído como pessoa jurídica precisa guardar registros de acesso (IP, data e hora) por 6 meses. Hoje o aplicativo não mantém esse registro: o IP fica só em memória e em limites de tentativa de até 15 minutos, e os logs do proxy reverso dependem da configuração do servidor. Definir o prazo e então implementar a guarda, sob sigilo e com acesso restrito.
2. **Aceite dos termos.** O cadastro mostra "Ao criar a conta, você concorda…", com links. A versão aceita e o horário do aceite não são gravados. Avaliar se é preciso registrar o aceite (e pedir novo aceite quando os termos mudarem).
3. **Arrependimento e reembolso.** As assinaturas são mensais, renovadas automaticamente e canceladas ao fim do período pelo portal do Stripe. Não há reembolso automático no código. Definir a regra e o procedimento de reembolso dentro de 7 dias.
4. **Retenção fiscal e de cobrança.** A exclusão de conta apaga do servidor o cliente Stripe vinculado, a situação da assinatura e os eventos de cobrança. O histórico de pagamento continua no Stripe. Confirmar se isso basta para as obrigações fiscais ou se algum registro precisa ficar no servidor, mesmo depois da exclusão.
5. **Backups.** Ainda não há rotina automática de backup externo. Definir o prazo de retenção antes de criar essa rotina e confirmar o texto sobre dados excluídos que permanecem nas cópias.
6. **Contas inativas.** Hoje nada é apagado por inatividade. Decidir se haverá prazo e aviso prévio.
7. **Transferência internacional.** Stripe, Resend, Meta, Google e Anthropic tratam dados fora do Brasil. O país do servidor de hospedagem precisa ser confirmado no contrato do provedor.
8. **Metadados de vídeo.** Imagens são regravadas sem metadados. Vídeos são guardados como enviados e podem conter local, aparelho e data. A política já informa isso; avaliar se basta o aviso ou se é melhor remover os metadados.
9. **Idade mínima e menores.** Definir a idade e se haverá verificação.
10. **Denúncias e remoção de conteúdo.** Não há fluxo de denúncia dentro do produto; a página de suporte indica o e-mail. Avaliar o procedimento.

## Fatos técnicos usados nas minutas

Antes de alterar o código, confira se o texto continua verdadeiro:

- Sessão de 7 dias em cookie HttpOnly; cookie temporário de OAuth; nenhum cookie de análise ou publicidade. A interface carrega fontes do Google Fonts (`dist/styles.css`).
- Links de conta: confirmação em 24 h e recuperação em 30 min, de uso único. O conteúdo do e-mail fica cifrado até a entrega e o registro é apagado em 7 dias (`lib/account.mjs`).
- Estado de OAuth dura 10 min; link assinado de mídia dura 1 h; tokens das redes são cifrados com AES-256-GCM (`lib/social.mjs`, `lib/launch-store.mjs`).
- Conteúdo, exportações, referências e agendamentos ficam até o titular removê-los. Exportações que falham ou são canceladas têm o arquivo apagado na hora (`worker.mjs`, `lib/api.mjs`).
- As sugestões de frases enviam à Anthropic apenas a descrição, com até 1.000 caracteres, e não registram descrição nem resposta (`lib/phrase-ai.mjs`).
- A exclusão de conta é descrita em [Contas e e-mail](CONTAS-EMAIL.md#exclusão-de-conta).
