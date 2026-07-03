# Kør en rigtig mission (natten over)

Dette er prøven der tæller: at lade motoren arbejde mod et af **dine egne repos** og
se om den producerer PR'er du faktisk ville merge — springet fra "alle søm er grønne"
til "den bærer vand" (backlog §Nordstjerne #4). Alt andet (observability, cost,
checks) er der for at gøre netop denne kørsel til at stole på.

## 1. Forudsætninger

Motoren kører som tre processer der deler Postgres:

- **agent-api** (`:8787`) — HTTP-API'et.
- **mission-worker** — baggrunds-loopet der driver kørende missioner.
- **agent-web** (`:3400`) — dashboardet.

Lokalt starter `pnpm dev` alle tre (og `docker compose` rejser Postgres). I prod
kører de under PM2 (se [deploy-topologien](../README.md)).

Sæt i `.env` (se [.env.example](../.env.example)):

| Nøgle | Hvorfor |
|---|---|
| `SUPABASE_DB_URL` | projekter + missioner (påkrævet) |
| `MISTRAL_API_KEY` / model-nøgle | agenterne (mindst én provider) |
| `GITHUB_TOKEN` + `MISSION_PUBLISH_PR=true` | for at publicere en draft-PR med nattens arbejde |
| `MISSION_CHECKS=typecheck,test` | default-verifikation (kan overstyres pr. mission) |
| `LLM_COST_PER_MTOK=3` | valgfrit — estimeret cost-udlæsning i UI'et |
| `LANGSMITH_TRACING=true` + `LANGSMITH_API_KEY` + `LANGSMITH_PROJECT_URL` | valgfrit — "Traces"-link fra dashboardet |
| `MISSION_LOG_JSON=true` | valgfrit — struktureret JSON-log pr. event |

> **Verifikation er kun så stærk som repoets checks.** Vælg `checks` der matcher det
> repo missionen arbejder i (fx `typecheck,test` hvis det har dem). Har repoet ingen
> rigtige checks, hviler "færdig" kun på kritikeren — vælg da checks bevidst.

## 2. Start missionen

To veje — begge ender samme sted (worker'en samler den op på næste poll):

### A) Via dashboardet
Åbn `http://localhost:3400`, vælg/opret et projekt bundet til dit repo, skift til
**Mission**, skriv mål + acceptkriterier, vælg **checks** og team, og tryk **Start**.

### B) Via scriptet (turnkey)
```bash
export AGENT_API_KEY=<din-api-nøgle>
export MISSION_GITHUB=arzonic-io/ranky        # eller MISSION_REPO=/sti/til/repo
export MISSION_GOAL="Tilføj en /health-endpoint med en test der består"
export MISSION_CRITERIA="endpoint svarer 200; en test dækker den"
export MISSION_CHECKS=typecheck,test
export MISSION_BUDGET=2000000                  # valgfrit token-loft
pnpm mission
```
Scriptet opretter projektet (bundet til repoet) + missionen og printer dashboard-linket.
Genbrug et eksisterende projekt med `MISSION_PROJECT_ID=<id>` (springer oprettelsen over).

## 3. Overvåg (asynkront)

- **Dashboardet** (`/missions/<id>`): backlog-board, budget-burn + est. cost, parkerede
  items (Godkend/Afvis), og **Styring** (fri-tekst kurskorrektion uden at stoppe loopet).
- **Traces** (hvis LangSmith er slået til): knap i headeren → agenternes ræsonnement.
- **Logs**: `pm2 logs mission-worker` (eller dev-konsollen). Med `MISSION_LOG_JSON=true`
  er hver event en JSON-linje du kan `jq`/aggregere.
- **Kill switch**: Stop-knappen; deadline/budget stopper også preemptivt.

## 4. Om morgenen

- **Draft-PR'en** (hvis `MISSION_PUBLISH_PR=true`) er review-artefaktet — "Se PR" på
  dashboardet, eller find `mission/<id>/integration`-branchen.
- **Stop-grunden** står på dashboardet (done / budget / deadline / no-progress / blokeret).
- Læs diffs pr. item (især parkerede) før du merger.

**Det er testen:** ville du merge den PR? Kunne du ikke *forstå* hvad den lavede →
næste skridt er observability. Var den grøn men forkert → næste skridt er stærkere
verifikation (bedre checks / flere review-runder).
