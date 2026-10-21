# ViceClipz Studio

Etapa 1 de 3: protótipo interativo com identidade própria. Veja [o plano](docs/PLANO.md).

## Executar

Requer Node.js 20 ou superior. Não há dependências para instalar.

```sh
npm run dev
```

Abra http://127.0.0.1:4173. `npm run check` verifica a sintaxe do JavaScript.

## Testar a experiência

1. Criar um projeto, preencher nome e headline e explorar três títulos.
2. Trocar template e proporção; opcionalmente selecionar vídeo de até 100 MB.
3. Escolher data e salvar. Encontrar em Projetos e Calendário.
4. Reabrir e alterar; recarregar a página e confirmar persistência dos metadados.
5. Filtrar templates e buscar um nome inexistente para ver o estado vazio.

Não há edição ou exportação de vídeo real, IA, login, cobrança ou conexão com redes sociais. As sugestões são geradas por regras locais. Rascunhos usam `localStorage` no navegador atual; arquivos de vídeo são temporários, não são enviados e precisam ser selecionados novamente ao reabrir. Fontes do Google são opcionais; fontes do sistema são fallback. Não coloque informações sensíveis em um navegador compartilhado.

`dist/` contém os arquivos estáticos publicáveis. `server.mjs` serve apenas uma lista fixa de arquivos em loopback. `.openai/hosting.json` registra a prévia privada de Sites. O plano do MVP e as decisões de arquitetura estão em `docs/PLANO.md`.
