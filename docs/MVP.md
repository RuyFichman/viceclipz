# Etapa 2 — MVP funcional

## Entrega

Contas com cadastro/login/logout; biblioteca privada de vídeos; projetos persistentes; corte por tempo, enquadramento central ou vídeo inteiro com bordas, três proporções, três temas, headline com posição e tamanho, remoção de áudio; composição visual e exportação real MP4. Fila com progresso, cancelamento, até três tentativas por job, recuperação de interrupção e download autenticado. Calendário continua sendo planejamento por data, sem publicação social.

## Como executar

Node.js 24 ou superior. No diretório `viceclipz-studio`:

```sh
npm ci
npm run dev
```

Abra **http://127.0.0.1:4173/**, escolha **Criar conta** e use seu e-mail e uma senha de 10 a 128 caracteres. O endereço exato importa: o backend valida Host/Origin. Não há envio de e-mail ou confirmação de titularidade nesta etapa.

1. Em Novo projeto, selecione ou envie um MP4, MOV ou WebM.
2. Ajuste início/fim em segundos, proporção, headline, tema e enquadramento.
3. Use Reproduzir corte para revisar. Salve o projeto ou clique em Exportar MP4.
4. Em Exportações, acompanhe a fila e baixe o resultado.

O servidor e o worker devem permanecer em execução durante a exportação. Fechar o navegador não interrompe o job. Reiniciar o servidor preserva contas, uploads, projetos e exportações prontas; jobs interrompidos podem ser repetidos. A aplicação detecta conflitos de edição em duas abas e pede reabertura do projeto.

## Limites explícitos

| Recurso | Limite |
| --- | --- |
| Upload | 100 MiB por arquivo, vídeo de até 10 minutos |
| Resolução de entrada | Até 4096 × 4096 |
| Espaço por conta | 2 GiB, incluindo originais e MP4 gerados |
| Corte/exportação | 0,25 a 120 segundos |
| Saídas | 720 × 1280, 720 × 720, 720 × 900 |
| Codec | H.264/yuv420p, 30 fps; AAC 128 kbps quando há áudio |
| Fila | Dois jobs ativos por conta; um worker global |
| Tentativas | Até três execuções por job; nenhuma cobrança |

Cada job ativo reserva 100 MiB na cota. Apenas o tamanho real é contabilizado após sucesso. Jobs cancelados/falhos não contam como exportações concluídas. Pedir novamente a mesma composição reutiliza o job/MP4 existente. Alterar o projeto cria um novo snapshot; exportações anteriores ficam preservadas até serem removidas.

Preview de MOV/WebM depende dos codecs aceitos pelo navegador; um arquivo aceito pelo servidor pode não reproduzir localmente antes de ser convertido. O enquadramento é central, sem arrastar o ponto de corte. Textos longos reduzem automaticamente o tamanho para caber na área segura. Vídeos pequenos podem ser ampliados e perder nitidez.

## Arquitetura implementada

`Navegador → API Node → SQLite + arquivos privados → worker separado → FFmpeg → MP4 autenticado`

- SQLite WAL com statements parametrizados. Cada conta é um workspace individual; todas as consultas de recursos exigem proprietário.
- Senhas com scrypt e salt aleatório. Cookies HttpOnly/SameSite=Strict, tokens de sessão aleatórios de 256 bits, apenas hashes no banco, validade de sete dias; Secure quando APP_ORIGIN usa HTTPS.
- Validação de Origin, Host e cabeçalho de mutação; sem CORS público. Limite de tentativas de autenticação por IP. Frontend usa textContent para dados fornecidos pelo usuário.
- Upload em streaming para staging; inspeção via ffprobe antes de aceitar. Tamanho, duração, resolução e formato verificados no servidor. Sem importar links remotos.
- Worker com FFmpeg em processo filho, argumentos em array e sem shell. Protocolos de mídia limitados a arquivos locais, limite de duração e timeout. O PNG de texto usado na prévia é produzido pelo mesmo compositor da renderização.
- Downloads e reprodução exigem sessão do proprietário e suportam HTTP Range. Nesta topologia não são necessárias URLs assinadas externas: os arquivos nunca são estáticos/publicáveis.

**Decisão em relação ao plano inicial:** PostgreSQL e object storage foram substituídos nesta entrega por SQLite e disco privado para executar o fluxo completo sem serviços externos ou credenciais. Esta versão é de instância única. A migração para banco/armazenamento gerenciados e workers escaláveis pertence à implantação da etapa 3.

## Arquivos e operação

- `data/viceclipz.sqlite`: contas, sessões, assets, projetos e jobs.
- `data/assets/`: vídeos originais, identificados por UUID.
- `data/exports/`: MP4 final por job.
- `data/temp/`: arquivos em processamento, nunca servidos.

`data/`, resultados de teste, caches e `.env` estão ignorados no Git. Não publicar o diretório de dados. Nunca executar dois servidores/workers sobre o mesmo DATA_DIR simultaneamente.

Backup simples para este MVP: interromper o servidor de forma normal, copiar o diretório `data/` inteiro para armazenamento protegido e reiniciar. Para restaurar, parar o servidor e restaurar banco e arquivos do mesmo snapshot. Não copiar só o arquivo `.sqlite` enquanto o banco estiver ativo em WAL. A rotina de backup/restauração automatizada será validada na etapa 3.

Variáveis opcionais: `PORT`, `HOST`, `APP_ORIGIN`, `DATA_DIR`, `FFMPEG_PATH`, `FFPROBE_PATH`, `FONT_PATH`. No Node 24, passar arquivo de configuração com `node --env-file=.env server.mjs` se necessário; `.env` não é carregado automaticamente por `npm start`.

O servidor inicia um worker supervisionado. Uma interrupção sinaliza falha recuperável no próximo início; nenhum progresso falso de sucesso é exibido. A pasta de staging abandonada é limpa ao iniciar. Os vídeos originais só podem ser removidos quando não há projetos/jobs ativos que os utilizam.

## Implantação

O endereço privado do Sites continua sendo o protótipo da etapa 1. O MVP exige Node/FFmpeg e disco persistente; não cabe na hospedagem estática nem no runtime Cloudflare Workers utilizado ali.

`Dockerfile` e `compose.yaml` fornecem configuração de servidor Linux com FFmpeg, fontes e volume persistente. Para usar localmente, pare primeiro o servidor Node da porta 4173 e execute `docker compose up --build -d`. Antes de acesso externo: configurar domínio/APP_ORIGIN HTTPS, proxy TLS, limites de requisição, envio de e-mail e recuperação de conta, controle de cadastro e rotina de backup. O Compose usa loopback por padrão e não publica o serviço na rede.

Não implementado nesta etapa: verificação de e-mail, recuperação de senha, login social, colaboração entre membros, legendas automáticas, IA, billing e publicação em redes sociais. Nenhuma alegação de operação SaaS pública pronta é feita.

## Verificação

```sh
npm run check
npm test
```

Testes usam servidor na porta 4187, banco isolado `.test-data-<uuid>` e vídeos sintéticos; não alteram contas reais. `test-results/<uuid>` preserva os MP4, um frame e um relatório. A suíte verifica login/logout, cookies, CSRF, isolamento entre usuários, upload inválido, HTTP Range, revisões de projeto, MP4 nas três proporções, duração do corte, áudio/mute, vídeo sem áudio, idempotência, cancelamento, retry, persistência e liberação de espaço.

Também foi validado no navegador: login de conta de teste, upload pelo seletor de arquivos, edição, exportação, estado MP4 pronto, download, reabertura do projeto e reprodução do corte.
