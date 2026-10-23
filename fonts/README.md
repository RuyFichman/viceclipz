# Fontes do renderizador de templates

Estas fontes são usadas apenas no servidor (`lib/template-render.mjs`) para desenhar o cartão de perfil e as faixas de frase dos templates. Elas não são servidas ao navegador: a prévia do editor exibe o PNG gerado pelo próprio servidor.

Todas são distribuídas sob a SIL Open Font License 1.1. O texto da licença de cada família acompanha os arquivos.

| Arquivo | Família | Licença | Origem |
| --- | --- | --- | --- |
| `Inter-Regular.ttf`, `Inter-Bold.ttf`, `Inter-Black.ttf` | Inter | `OFL-Inter.txt` | Google Fonts via `@expo-google-fonts/inter` 0.4.2 |
| `Montserrat-ExtraBold.ttf` | Montserrat | `OFL-Montserrat.txt` | Google Fonts via `@expo-google-fonts/montserrat` |
| `Anton-Regular.ttf` | Anton | `OFL-Anton.txt` | Google Fonts via `@expo-google-fonts/anton` |
| `BebasNeue-Regular.ttf` | Bebas Neue | `OFL-BebasNeue.txt` | Google Fonts via `@expo-google-fonts/bebas-neue` |

Os arquivos não foram modificados. Ao adicionar uma fonte, inclua a licença, registre-a em `lib/template-render.mjs` e na lista `FONTS` de `dist/template-core.js`.

As fontes não incluem emoji; caracteres sem glifo aparecem como caixas vazias no MP4.
