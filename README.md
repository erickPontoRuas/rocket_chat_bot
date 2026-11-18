# Rocket.Chat Issue Bot

Bot em Node.js que observa um canal do Rocket.Chat via DDP, conduz uma conversa em thread com o autor da mensagem, guarda o estado no Redis e cria uma issue em um repositório do GitHub ao final.

Esta é a base do projeto. O fluxo real de perguntas será decidido por IA em uma etapa futura; por enquanto, existe um planner sequencial de exemplo que pergunta campos de um relato de bug e cria a issue de ponta a ponta.

## Requisitos

- Node.js 20 ou superior
- Redis 7 (ou via Docker Compose)
- Conta de bot no Rocket.Chat com acesso ao canal monitorado
- Fine-grained PAT do GitHub com permissão `Issues: Read and write` no repositório alvo

## Configuração

```bash
npm install
cp .env.example .env
```

Preencha o `.env`:

| Variável                   | Obrigatória | Descrição                                           |
| -------------------------- | ----------- | --------------------------------------------------- |
| `ROCKETCHAT_URL`           | sim         | URL do Rocket.Chat, ex.: `https://chat.exemplo.com` |
| `ROCKETCHAT_USER`          | sim         | usuário da conta do bot                             |
| `ROCKETCHAT_PASSWORD`      | sim         | senha da conta do bot                               |
| `ROCKETCHAT_ROOM_ID`       | sim         | ID do canal monitorado                              |
| `REDIS_URL`                | sim         | ex.: `redis://localhost:6379`                       |
| `GITHUB_TOKEN`             | sim         | PAT usado pelo Octokit                              |
| `GITHUB_OWNER`             | sim         | owner do repositório                                |
| `GITHUB_REPO`              | sim         | nome do repositório                                 |
| `GITHUB_LABELS`            | não         | labels separadas por vírgula                        |
| `CONVERSATION_TTL_SECONDS` | não         | TTL da conversa no Redis (padrão `86400`)           |

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

1. O bot conecta no Rocket.Chat por DDP, autentica com usuário/senha, entra no canal e assina o stream de mensagens do próprio usuário (`__my_messages__`).
2. O handler descarta mensagens de outros canais, do próprio bot, de sistema, editadas, vazias e duplicadas.
3. A primeira mensagem de um usuário no canal abre uma conversa com chave `conversation:{roomId}:{userId}` no Redis e thread raiz igual a `tmid` ou `_id` da mensagem.
4. O planner decide a próxima ação:
   - `ask`: envia a pergunta na thread e guarda qual campo está pendente;
   - `create_issue`: cria a issue via Octokit e envia o link na thread;
   - `ignore`: registra e não responde.
5. As respostas seguintes do mesmo usuário no canal são gravadas no campo pendente até o planner concluir.
6. Após criar a issue, o estado da conversa é removido para que a próxima mensagem comece um novo atendimento.

O TTL padrão da conversa é de 24 horas, renovado a cada atividade. Locks no Redis evitam processamento concorrente da mesma conversa e criação duplicada de issue.

## Estrutura

```text
src/
├── index.ts                              # bootstrap e shutdown
├── config/env.ts                         # validação do ambiente com zod
├── logger.ts                             # pino
├── bot/
│   ├── rocket-chat.client.ts             # DDP, login, stream e envio em thread
│   └── message-handler.ts                # filtros e deduplicação
├── conversation/
│   ├── types.ts                          # contratos e tipos de domínio
│   ├── state.repository.ts               # persistência no Redis
│   ├── conversation.service.ts           # orquestração do fluxo
│   └── planner/sequential.planner.ts     # stub até a integração da IA
├── flows/
│   ├── issue-report.fields.ts            # campos placeholder do relato
│   └── answers.ts                        # consolidação das respostas
├── integrations/github/
│   ├── github.client.ts                  # Octokit
│   └── issue.builder.ts                  # respostas + metadados → issue
└── utils/
    ├── lock.ts                           # lock distribuído no Redis
    └── errors.ts                         # erros de domínio
```

## Ponto de extensão para a IA

O contrato está em `src/conversation/types.ts`:

```ts
interface ConversationPlanner {
  evaluate(input: PlannerInput): Promise<PlannerDecision>;
}
```

`SequentialPlanner` é apenas a implementação temporária. Para integrar a IA, crie outro planner que use o histórico/respostas para decidir se faz uma pergunta ou se já pode criar a issue, e injete-o em `src/index.ts`. A interface e o restante do fluxo não precisam mudar.

## Limitações conhecidas

- `@rocket.chat/sdk` é um SDK beta e antigo; a reconexão é delegada ao Asteroid, com logs de acompanhamento.
- O bot assina o stream do próprio usuário e filtra pelo `ROCKETCHAT_ROOM_ID`, em vez de assinar um stream específico do room.
- A deduplicação de mensagens usa `dedupe:msg:{id}` com TTL de 1 hora.
- Uma conversa por usuário e canal. Mensagens fora da thread ativa do mesmo usuário são tratadas como resposta.
- Se o processo cair entre a criação da issue e a limpeza do estado, uma nova tentativa pode criar uma issue duplicada; o lock reduz a janela, mas não elimina esse caso.
- Enquanto a conversa estiver ativa, o bot não distingue respostas de conversa paralela do mesmo usuário no canal.
