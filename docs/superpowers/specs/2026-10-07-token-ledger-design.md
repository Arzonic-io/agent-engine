# Token-ledger: forbrug pr. modelkald

**Fase 0, etape A** fra Jev-vurderingen (7. oktober 2026). Godkendt omfang: måling + panel. Budgettet forbliver uændret.

## Formål

Vis, hvad en korrekt afsluttet opgave koster, og hvorfor. I dag gemmer vi kun missionens samlede tal (`missions.spent_tokens`), og det tal har kendte huller (F08 i gennemgangen fra 14. september): surveyen tælles ikke, og tokens fra løkker, der fejler, forsvinder. Ledgeren skal give det grundlag, som de næste beslutninger kræver: hvilke roller der koster mest, hvad spildet koster, og senere om Clef eller Jev kan tage beslutninger billigere.

Styrende tal: **samlet forbrug, inklusive fejlslagne forsøg, pr. korrekt afsluttet item.**

## Krav

| Område | Krav |
|---|---|
| Sporbarhed | Hvert modelkald knyttes til mission, item, forsøg, rolle, udbyder og model. Interaktive kørsler knyttes til kørslens id. |
| Fuldstændighed | Hver tur i værktøjsløkkerne tælles, også i en løkke, der fejler bagefter. Fejlede modelkald registreres. Surveyen tælles. |
| Pris | Rå tal gemmes (frisk input, cache-skriv, cache-læs, output). Estimeret USD beregnes fra en dateret pristabel. En model uden verificeret pris giver ukendt pris, aldrig 0. |
| Pålidelighed | Intet kald tælles dobbelt: kaldets id er unikt, og skrivning er idempotent. Manglende tal gemmes som ukendt (NULL), ikke 0. Kald, der ikke kunne gemmes, efterlader en synlig hulrække. |
| Resultat | Forbrug pr. item med status og antal forsøg. Forbrug pr. færdigt item inklusive spild og fælles arbejde. Budgettets eget tal vises ved siden af det målte. |
| Robusthed | Målingen må aldrig vælte et modelkald eller forhindre API'et og workeren i at starte. |

## Uden for denne etape

- **Budgettet skifter ikke grundlag.** Næste plan: budget og watcher læser fra ledgeren, så F08 lukkes.
- **Embeddings** (`mistral-embed` i projekthukommelsen) og **eksterne MCP-servere** måles ikke. De står som kendte huller.
- **Ingen brugerflade for interaktive kørsler.** De får kun et API-endpoint.
- **Beslutningsporten** med Clef og Jev hører til fase 0, del 2.
- **Kvalitetsregler for "færdig"** hører til etape B.

## Arkitektur

```
yderste kald (runner / runs.service / komponent)          LangChain-callbacks
  callbacks: [recorder.handler]                    ─────▶ handleChatModelStart: gem metadata
  metadata: ae_mission_id, ae_item_id,                    handleLLMEnd:        byg række
            ae_attempt_id | ae_task_id                     handleLLMError:      byg fejlrække
        │                                                         │
        ▼                                                         ▼
  node / komponent: withUsage("<rolle>", config)          buffer i hukommelsen
        │                                                         │ flush hvert sekund
        ▼                                                         ▼
  modelkald (også hver tur i createReactAgent)            llm_usage (Postgres)
                                                                  │
                                         GET /missions/:id/usage ◀┘  →  panel "Forbrug pr. rolle"
```

- **core** (ren TypeScript, ingen I/O): `usage.ts` definerer roller, metadata-nøgler og `withUsage`. Hvert af de 16 målepunkter markerer sin rolle. Runneren giver hvert forsøg et id og sætter mission, item og forsøg på kørslens metadata. Komponenterne uden for grafen (survey, decomposer, replanner, rubric-assessor og test author) tager runtime'ens `callbacks` og læser mission, item og forsøg fra deres eget input.
- **shared**: `pricing.ts` (pristabel), `usageRecorder.ts` (callback og buffer) og `usageLedger.ts` (Postgres-tabel og opsummeringer).
- **api og worker**: én recorder pr. proces. Callbacks sættes på det yderste kald, aldrig på selve modellen. Kun som arvelige callbacks bærer LangChain metadata fra det yderste kald ned til hvert indlejret modelkald, og det er verificeret i LangChain 1.1.49.
- **web**: panelet "Forbrug pr. rolle" på missionssiden.

## Datamodel: `llm_usage`

| Kolonne | Type | Bemærkning |
|---|---|---|
| `call_id` | uuid PK | LangChains run-id for kaldet. Garanterer én række pr. kald. |
| `at` | timestamptz | Hvornår kaldet sluttede. |
| `mission_id` | uuid, FK missions ON DELETE CASCADE | |
| `item_id` | uuid, FK backlog_items ON DELETE CASCADE | |
| `attempt_id` | uuid | Ét id pr. kørsel af et item. |
| `task_id` | uuid, ingen FK | Kørsler uden projekt har intet `tasks`-id. |
| `role` | text | Fx `implementer` eller `missionCritic`. `unrecorded` på hulrækker. |
| `provider`, `model` | text | Modellen, der faktisk svarede, når udbyderen oplyser den. |
| `status` | text | `ok`, `error` eller `dropped` (hulrække). |
| `calls` | integer | 1 for et kald. Antal tabte kald på en hulrække. |
| `usage_known` | boolean | false, når udbyderen ikke oplyste forbrug. |
| `input_fresh`, `cache_write`, `cache_read`, `output` | bigint, NULL = ukendt | |
| `billable` | bigint | Samme vægtning som budgettet (`billableTokens`). |
| `cost_usd` | numeric(14,6), NULL = ukendt pris | |
| `latency_ms` | integer | Bruges senere til at sammenligne Clef og Jev. |

## Opsummering (API)

`GET /missions/:id/usage` og `GET /runs/:id/usage` returnerer:

- `totals`: kald, ukendte kald, fejlede kald, tabte kald, kald uden pris, de fire tokenklasser, betalte tokens og estimeret USD.
- `byRole`: det samme pr. rolle, sorteret efter forbrug, med de modeller rollen brugte.
- `byItem` (kun missioner): titel, status, antal forsøg, kald, betalte tokens og pris.
- `outcome` (kun missioner):
  - antal færdige items
  - forbrug på færdige items, på andre items og på fælles arbejde
  - forbrug pr. færdigt item, alt inklusive
- `budgetCounted`: missionens eget tal.
- `costComplete`: false, så længe nogle kald er ukendte, tabte eller uden pris.
- `firstCallAt` og `priceTableVersion`.

## Fejlhåndtering

- Callbacken skriver kun til en buffer i hukommelsen, så den kan aldrig vælte et modelkald.
- Er databasen nede, bliver rækkerne i bufferen og prøves igen. Udfaldet logges én gang, ikke ved hver flush.
- En række, databasen afviser (fx fordi missionen er slettet), tælles og logges. Rækkerne bagved skrives stadig.
- Løber bufferen fuld, droppes de ældste kald, og der skrives en hulrække pr. mission eller kørsel, når databasen er tilbage.
- Fejler skemaet ved opstart, kører API og worker videre uden måling. Det logges.

## Verifikation

- **core:** verify-scripts med falske modeller, der går gennem LangChains rigtige kaldsvej. De viser:
  - at konteksten overlever kørselstræet, også inde i `createReactAgent`
  - at runneren giver hvert forsøg sit eget id
  - at alle 16 målepunkter markerer deres rolle
- **shared:** verify-scripts for pristabellen og for recorderen (rækkens indhold, ukendt forbrug, fejlkald, nedbrud, afvisning, overløb og `close`). Derudover et Postgres-verify for ledgeren, der kræver lokal database som `verify-memory`.
- **Hele repoet:** `pnpm typecheck`, og alle eksisterende hermetiske verify-scripts består.
- **Live:** en lille kørsel giver rækker i `llm_usage`, og panelet viser dem. Det kræver brugerens accept, fordi det koster rigtige modelkald.
