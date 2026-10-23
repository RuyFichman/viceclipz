# ViceClipz Studio — v0.3

Novidade: editor de templates em 7 etapas (Post card, Meme e Vídeo viral) com cartão de perfil, zonas de vídeo e imagem, frases, estilos salvos e lotes de até 50 variações em MP4. Consulte [templates e variações](docs/TEMPLATES.md).

Também: biblioteca de referências de sites/RSS/Atom, Instagram e TikTok; métricas do estúdio e apresentação em `/sobre`. Consulte [configuração, limites e validação](docs/COLETA-METRICAS.md).

Contas, upload, edição e MP4 real, agora com interface para integrações sociais, agendamento e assinaturas. Backend Node/SQLite/FFmpeg persistente; interface preparada para Vercel. Consulte o [guia de deploy e ativação](docs/DEPLOY-VERCEL.md). Credenciais externas e domínio ainda não estão configurados. A hospedagem Sites da etapa 1 continua sendo apenas a prévia antiga.

## Executar

Requer **Node.js 24+**. As dependências incluem binários FFmpeg/ffprobe e composição de texto.

```sh
npm ci
npm run dev
```

Abra **http://127.0.0.1:4173/** e crie sua conta. Em **Templates**, escolha um modelo e siga as etapas: perfil, zonas, frases, mídia, estilo, variações e gerar. Acompanhe o lote no próprio editor ou em **Exportações** e faça o download. Projetos criados antes dos templates continuam no editor clássico.

Até 100 MB por arquivo e 10 minutos por vídeo; imagens PNG, JPEG ou WebP; corte final de até 120 segundos; templates em 720 × 1280 e projetos clássicos também em 720 × 720 e 720 × 900. Sugestões automáticas de frases exigem `ANTHROPIC_API_KEY` no backend. Localmente, 2 GB por conta e integrações desativadas até configurar as credenciais. Em produção, cotas dependem do plano.

## Validar

```sh
npm run check
npm test
```

Os testes criam contas e vídeos sintéticos em uma instância separada, verificam o isolamento entre usuários e decodificam os MP4 gerados. Evidências ficam em `test-results/`, ignorado no Git.

## Documentação

- [Guia do MVP, arquitetura, limites, operação e implantação](docs/MVP.md)
- [Templates, zonas, frases, lotes de variações e frases automáticas](docs/TEMPLATES.md)
- [Plano de três etapas](docs/PLANO.md)
- [Deploy Vercel, backend persistente e ativação dos provedores](docs/DEPLOY-VERCEL.md)
- [Evidências de validação da etapa 3](docs/VALIDACAO-ETAPA3.md)
- [Verificação de e-mail, recuperação de senha e configuração Resend](docs/CONTAS-EMAIL.md)

`data/` contém informações privadas e não pode ser publicado nem versionado. SQLite usa WAL e esta versão exige instância única. O Compose local usa loopback; o Compose de produção inclui proxy HTTPS e volume persistente. Execução do contêiner ainda precisa ser validada com Docker Engine. Verificação de e-mail e recuperação de senha estão implementadas; envio real depende de configurar Resend, remetente e chave de cifragem. O backend de produção exige verificação e permite apenas convites configurados.
