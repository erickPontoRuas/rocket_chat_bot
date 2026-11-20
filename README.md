# Rocket.Chat Issue Bot

Bot em Node.js que observa um canal do Rocket.Chat via DDP, avalia o relato de um problema com IA, conduz uma conversa no canal para coletar os itens faltantes, guarda o estado no Redis e cria uma issue em um repositório do GitHub ao final.

## Requisitos

- Node.js 20 ou superior
- Redis 7 (ou via Docker Compose)
- Conta de bot no Rocket.Chat com acesso ao canal monitorado
- Fine-grained PAT do GitHub com permissão `Issues: Read and write` no repositório alvo
- Chave da API da OpenAI
- Labels `ATRAPALHA` e `PERDE VENDA` criadas no repositório do GitHub

## Configuração

```bash
npm install
cp .env.example .env
```

Preencha o `.env`:

| Variável                   | Obrigatória | Descrição                                                          |
| -------------------------- | ----------- | ------------------------------------------------------------------ |
| `ROCKETCHAT_URL`           | sim         | URL do Rocket.Chat, ex.: `https://chat.exemplo.com`                |
| `ROCKETCHAT_USER`          | sim         | usuário da conta do bot                                            |
| `ROCKETCHAT_PASSWORD`      | sim         | senha da conta do bot                                              |
| `ROCKETCHAT_ROOM_ID`       | sim         | ID do canal monitorado                                             |
| `REDIS_URL`                | sim         | ex.: `redis://localhost:6379`                                      |
| `GITHUB_TOKEN`             | sim         | PAT usado pelo Octokit                                             |
| `GITHUB_OWNER`             | sim         | owner do repositório                                               |
| `GITHUB_REPO`              | sim         | nome do repositório                                                |
| `GITHUB_LABELS`            | não         | labels fixas, separadas por vírgula; labels de nível são ignoradas |
| `OPENAI_API_KEY`           | sim         | chave usada pelo SDK da OpenAI                                     |
| `OPENAI_MODEL`             | não         | modelo usado na avaliação e no título (padrão `gpt-4o-mini`)       |
| `OPENAI_BASE_URL`          | não         | URL de um endpoint compatível com a API da OpenAI                  |
| `OPENAI_TIMEOUT_MS`        | não         | timeout de cada chamada de IA (padrão `30000`)                     |
| `CONVERSATION_TTL_SECONDS` | não         | TTL da conversa no Redis (padrão `86400`)                          |

Subir o Redis local:

```bash
docker compose up -d redis
```

## Executar

```bash
npm run dev        # desenvolvimento com watch
npm run build      # compila para dist/
npm start          # executa o build
```

Qualidade:

```bash
npm run lint
npm run typecheck
npm test
npm run format:check
```

## Como funciona

1. O bot conecta no Rocket.Chat por DDP, autentica com usuário/senha, entra no canal e assina o stream de mensagens.
2. O handler descarta mensagens de outros canais, do próprio bot, de sistema, editadas, vazias e duplicadas. Mensagens somente com anexo são aceitas.
3. Na primeira mensagem de um usuário no canal, a IA avalia o texto e os anexos e verifica quais dos 9 itens obrigatórios já estão presentes:
   - nível (`ATRAPALHA` ou `PERDE VENDA`);
   - ID do atendimento;
   - etapa do funil;
   - o que o cliente disse ou pediu;
   - o que o bot do sistema externo fez;
   - o que o bot do sistema externo deveria ter feito;
   - regra de negócio;
   - já aconteceu antes?;
   - print.

   A IA também informa se a mensagem contém um relato real (`hasReportContent`) e uma evidência literal para cada item marcado como presente.

4. O bot valida a resposta da IA: o item só conta como presente quando a evidência existe de fato na mensagem/anexo, o valor é específico e não está repetido entre campos. Mensagens triviais (como `teste`), genéricas ou sem informação útil são tratadas como relato vazio. Itens ausentes entram em uma fila; o bot envia um resumo com os itens faltantes, lembra que o usuário pode responder `não se aplica` e faz a primeira pergunta.
5. Cada resposta é gravada no item que estava pendente, sem validação de conteúdo. `não se aplica` é preservado literalmente. A exceção é o nível, que é normalizado pela IA para `ATRAPALHA` ou `PERDE VENDA`; se continuar inválido após uma repergunta, usa `ATRAPALHA`.
6. Quando a fila termina, a IA gera um título curto e o bot monta o corpo da issue com todas as respostas literais, metadados do atendimento e link da mensagem inicial.
7. A issue é criada no GitHub com o título sem nível e apenas a label do nível informado. `GITHUB_LABELS` adiciona somente labels fixas; labels de nível nessa variável são ignoradas. O bot responde no canal, mencionando `@username`, com número, título, nível, ID do atendimento e link da issue.
8. Após criar a issue, o estado da conversa é removido para que a próxima mensagem comece um novo atendimento.

O bot nunca cria nem responde em thread: todas as mensagens do fluxo são enviadas no canal. Mensagens recebidas com `tmid` (de uma thread existente) são tratadas como mensagens do canal. Cada resposta começa com a menção `@username`, o que permite atendimentos simultâneos de usuários diferentes no mesmo canal.

O item `print` é identificado por anexo de imagem ou URL de imagem no texto; o conteúdo da imagem não é analisado. O TTL padrão da conversa é de 24 horas, renovado a cada atividade. Locks no Redis evitam processamento concorrente da mesma conversa e criação duplicada de issue.

## Estrutura

```text
src/
├── index.ts                              # bootstrap e shutdown
├── config/env.ts                         # validação do ambiente com zod
├── logger.ts                             # pino
├── bot/
│   ├── rocket-chat.client.ts             # DDP, login, stream, envio no canal e tipos de anexo
│   └── message-handler.ts                # filtros, deduplicação e extração de anexos
├── conversation/
│   ├── types.ts                          # contratos e tipos de domínio
│   ├── state.repository.ts               # persistência no Redis
│   └── conversation.service.ts           # máquina de estados do atendimento
├── flows/
│   └── issue-report.fields.ts            # os 9 campos, perguntas e níveis
├── integrations/
│   ├── ai/
│   │   ├── types.ts                      # contratos de IA
│   │   ├── prompts.ts                    # prompts em português
│   │   ├── schemas.ts                    # JSON Schemas e parsers Zod
│   │   ├── openai.completion-client.ts   # SDK da OpenAI
│   │   └── openai.issue-assistant.ts     # intake, nível e título
│   └── github/
│       ├── github.client.ts              # Octokit e merge de labels
│       └── issue.builder.ts              # respostas + metadados → issue
└── utils/
    ├── lock.ts                           # lock distribuído no Redis
    └── errors.ts                         # erros de domínio
```

## IA

A avaliação inicial usa Structured Outputs (JSON Schema) e valida a resposta com Zod. O prompt trata o texto do relato como dado não confiável e instrui o modelo a ignorar comandos contidos nele. O modelo precisa classificar se a mensagem contém um relato real (`hasReportContent`) e, para cada item marcado como presente, devolver uma evidência literal copiada da mensagem ou do anexo.

O bot valida essa resposta de forma determinística antes de montar a fila: a evidência precisa existir de fato no texto/anexo, valores genéricos ou repetidos entre campos são descartados, o ID do atendimento precisa parecer um identificador e o print só é aceito por anexo de imagem ou URL presente na mensagem. Mensagens triviais (uma palavra, sem anexo) são tratadas como relato vazio. Em dúvida, o item volta para a fila e o usuário é perguntado; o resumo e as perguntas seguem um item por mensagem.

O modelo padrão é `gpt-4o-mini`, configurável por `OPENAI_MODEL`. O texto do relato e as URLs dos anexos são enviados à OpenAI para a avaliação inicial e a geração do título; o conteúdo das imagens não é enviado. Se a avaliação inicial falhar após uma retentativa, o bot avisa o usuário e segue com a fila completa dos 9 itens. Se a geração do título falhar, usa um título determinístico derivado do relato.

## Limitações conhecidas

- `@rocket.chat/sdk` é um SDK beta e antigo; a reconexão é delegada ao Asteroid, com logs de acompanhamento.
- O bot assina o stream do próprio usuário e filtra pelo `ROCKETCHAT_ROOM_ID`, em vez de assinar um stream específico do room.
- A deduplicação de mensagens usa `dedupe:msg:{id}` com TTL de 1 hora.
- Uma conversa por usuário e canal. Um segundo problema simultâneo do mesmo usuário no mesmo canal é tratado como resposta do atendimento ativo.
- O bot não usa threads; todas as respostas vão para o canal com menção `@username`, mesmo quando a mensagem do usuário veio de uma thread existente.
- Se o processo cair entre a criação da issue e a limpeza do estado, uma nova tentativa pode criar uma issue duplicada; o lock reduz a janela, mas não elimina esse caso.
- Mensagens que chegam enquanto outra da mesma conversa está em processamento podem ser descartadas pelo lock.
- O formato dos anexos varia entre versões do Rocket.Chat; a extração cobre `attachments`, `files` e `file`.
- Estados de conversa `version: 1` e `version: 2` são descartados; atendimentos em andamento precisam recomeçar.
