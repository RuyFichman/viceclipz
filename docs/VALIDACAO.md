# Validação da etapa 2

Verificação em 21/10/2026, Windows, Node.js 24.13.1.

- `npm run check`: passou.
- `npm test`: 12 testes contabilizados pelo Node, 12 passaram, nenhuma falha. Inclui o teste agregador e 11 cenários de integração.
- MP4 decodificado integralmente com FFmpeg nas três proporções; codec H.264/yuv420p, corte de 2 segundos, AAC quando habilitado e nenhuma faixa de áudio quando removido.
- Biblioteca, projetos, conta e downloads persistiram após reinício. Job em processamento foi interrompido, identificado como falho e concluído após nova tentativa.
- Isolamento entre duas contas, CSRF, cookies, uploads inválidos, leitura parcial HTTP Range, revisão concorrente, idempotência, limites de armazenamento/fila e cancelamento foram verificados.
- No navegador: login, upload pelo seletor de arquivos, edição, exportação, MP4 pronto, download concluído, projeto reaberto e reprodução do corte.

Evidências da execução final: `test-results/8b4aac4a-9777-467f-9d71-b78eb03b39ec/`, incluindo `summary.json`, `server.log`, três MP4 e `export-frame.png`. São arquivos locais ignorados pelo Git; novas execuções geram um novo UUID.

Docker Compose: configuração sintaticamente validada. O Docker Engine não estava disponível; build e execução da imagem **não foram testados**. A versão executada e validada é Node/FFmpeg nativo. Responsividade foi implementada; não houve teste dedicado em aparelho móvel físico.

O serviço final usa a porta 4173 e seu próprio diretório `data/`. Testes de integração usaram a porta 4187 e dados isolados; testes de interface usaram a porta 4188. As instâncias de teste foram encerradas. Nenhuma conta de teste foi criada no banco principal.
