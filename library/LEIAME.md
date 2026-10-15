# Catálogo da biblioteca de jogos

A tela "Biblioteca de jogos" lê `library/games.json`. Cada jogo listado aqui aparece como um card;
ao clicar, o navegador baixa o arquivo, guarda no OPFS e abre no emulador certo.

Coloque aqui só jogos que você tem direito de distribuir (homebrew, jogos próprios, licenças livres).

```json
{
  "games": [
    {
      "id": "meu-jogo",
      "title": "Meu Jogo",
      "system": "ps1",
      "url": "library/files/meu-jogo.chd",
      "fileName": "meu-jogo.chd",
      "size": 123456789,
      "cover": "library/covers/meu-jogo.jpg"
    }
  ]
}
```

Também vale o formato em português, um objeto por jogo:

```json
{ "nome": "X-Bladez - Inline Skater (Europe)", "foto": "", "pagina": "-", "plataforma": "PS1", "fonte": "CoolROM" }
```

Equivalências: `nome` = `title`, `plataforma` = `system` (PS1, PSX, PS2), `foto` = `cover`,
`arquivo` = `url`, `tamanho` = `size`. O sufixo "ROM (ISO) Download for ... - Site.com" sai do nome,
a imagem genérica `/images/128x128.gif` é ignorada e o número em `pagina` vira o `id` quando não há um.
**Entradas sem `url`/`arquivo` aparecem como "Importar arquivo"**: ao clicar, a pessoa escolhe a própria
cópia do jogo, que fica guardada naquele card.

- `id`: único, só letras, números, `-` e `_`. É o nome da cópia no navegador.
- `system`: `ps1` ou `ps2`.
- `url`: caminho no próprio site ou URL absoluta. URLs de outro domínio precisam responder com
  `Access-Control-Allow-Origin` (o site roda com COEP `require-corp`).
- `fileName`: opcional. A extensão decide o loader (PS1: chd, pbp, bin, img, iso, zip, 7z; PS2: iso, chd, cso, bin).
- `size`: opcional, em bytes. Usado para a barra de progresso e a checagem de espaço.
- `cover`: opcional. Capa quadrada; sem ela o card mostra o ícone de controle. Imagens de outro domínio
  só aparecem se o servidor delas mandar CORS ou `Cross-Origin-Resource-Policy: cross-origin`; o mais simples
  é guardar as capas em `library/covers/`.

Arquivos grandes (jogos de PS1 em CHD costumam ter 200 a 500 MB) ficam melhor num bucket com CORS
do que no deploy da Vercel.
