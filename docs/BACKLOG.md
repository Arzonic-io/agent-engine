# Agent Engine — Backlog

> Levende dokument. Her står hvad vi mangler at lave og hvilke features der kunne
> komme. Opdatér den løbende: kryds af, flyt punkter mellem sektioner, og log
> leverede ting under **Senest leveret**.

**Sidst opdateret:** 2026-06-16

## 🌙 Nordstjerne — Autonome missioner

Den langsigtede retning er at skifte filosofi: fra afgrænsede, menneske-gatede
enkeltopgaver til **langtkørende, selvudfordrende missioner** der arbejder videre
hele natten i et godt tempo, planlægger deres egen backlog, tester sig selv og
looper indtil målet er nået eller et budget/stop rammer. Mennesket bliver
**asynkron overvåger** (review-kø, milepæls-checkpoints, kill switch) i stedet for
en gate på hvert skridt.

To kørsels-modes: **Opgave** (afgrænset, ≤ ~15 min, som i dag) og **Mission**
(kontinuerlig, selvkørende). Fuld koncept-/målbeskrivelse i §5 af den samlede
[design-brief.md](design-brief.md) — det er pejlemærket alt nedenfor sigter efter.
Missions-køreplanen står under **Epics**.

## Sådan bruger du den

- `- [ ]` = ikke startet · `- [x]` = færdig · `🚧` = i gang · `🔒` = blokeret.
- Når et punkt er færdigt: sæt `[x]`, og flyt det op under **Senest leveret** med dato.
- Prioritet: **Must have** (kan ikke undværes) → **Need to have** (vigtigt, næste runde)
  → **Nice to have** (forbedringer / fremtid).
- Hold punkterne små nok til at kunne afsluttes i én PR. Store ting ligger under **Epics**.

---

## ✅ Senest leveret

### 2026-06-17 — Missioner Trin 1: schema + BacklogStore (fundament for Nordstjernen)
- [x] `BacklogStore`-interface + `Mission`/`BacklogItem`-typer (zod) i core
      ([packages/core/src/mission.ts](../packages/core/src/mission.ts)) — framework-fri,
      injiceret ligesom `ProjectMemory`/`RepoTools`.
- [x] Postgres-impl `BacklogService` i shared ([packages/shared/src/backlog.ts](../packages/shared/src/backlog.ts)):
      `missions` + `backlog_items`-tabeller (§5.2), idempotent `setup()`,
      CRUD + `nextActionable()` (højeste prioritet med opfyldte `dependsOn`).
- [x] Eksporteret fra begge pakkers `index.ts`; `turbo build` grøn (6/6).

### 2026-06-16 — Web-app: projekt-først composer + sidebar
- [x] Projekt-først composer: fjernet "Scratch", default til senest brugte projekt.
- [x] "Opret dit første projekt" + "Nyt projekt" som fuldskærms-flow (ikke stablet på opgaveformen).
- [x] Hukommelses-indikator (`N ting husket · sidste opgave …`) + team-roster i header.
- [x] Kvalitetskrav (Definition of Done) vist read-only i composeren.
- [x] Repo pr. projekt: gemmes i `projects.settings.repoPath`, arves af hver opgave.
- [x] Repo-vælger som VS-Code-agtig dropdown (portal, flyder over alt).
- [x] Backend: `GET /projects` m. stats, `GET /projects/:id/tasks`, `GET /rubric`,
      `PATCH /projects/:id`, `GET /tasks` (alle opgaver m. projektnavn).
- [x] Sidebar: projekt-liste m. skift, global "Seneste opgaver"-feed m. projektnavn,
      "N ved gaten"-badge, bundknap "Nyt projekt".
- [x] Run-side: højre inspector bag kant-tab/flap under `2xl`, chevron-pile, skubber ikke midten.
- [x] Dansk UI-tekst, Enter sender / Shift+Enter linjeskift.
- [x] Refaktor: `page.tsx` delt op i komponenter (`RepoMenu`, `CreateProjectView`,
      `DefinitionOfDone`, `RecentTasks`, `TeamRoster`) + delt `lib/format.ts`.

---

## 🔴 Must have

Ting der er i stykker, blokerer brug, eller mangler for at appen hænger sammen.

- [ ] **Hukommelse slået fra → pæn tilstand.** Når `SUPABASE_DB_URL`/`MISTRAL_API_KEY`
      mangler, fejler hele projekt-flowet med en rå 503. Vis en tydelig "aktivér
      projekt-hukommelse"-tilstand i stedet.
- [ ] **Opdatér README/docs.** README beskriver kun CLI/builder↔critic. Web-appen,
      projekter, hukommelse og nye agents (analyst/architect/lead/worker/router) er ikke nævnt.
- [ ] **Slet/omdøb projekt fra UI.** Backend har `DELETE /projects/:id` + `PATCH`,
      men der er ingen knap i web-appen endnu.
- [ ] **Rediger projekt-brief/navn i UI.** I dag kun ved oprettelse.
- [ ] **Kerne-tests.** Næsten ingen automatiserede tests (kun api-smoke). Mindst:
      rubric pass-regel, router-valg (single/team), memory store/retrieve.
- [ ] **Fejl- og tomme tilstande i web.** Fejl vises flere steder som rå servertekst;
      ensartede tomme/fejl/skeleton-tilstande mangler.

## 🟡 Need to have

Vigtigt for en god oplevelse — næste runde.

- [ ] **Router-override efter submit.** Vis valgt topology + grund på run-siden med en
      "Override"-kontrol (item 5 fra UI-brief). Kræver backend: tving topology + re-run.
- [ ] **Per-projekt rubric.** I dag bruges global `defaultRubric`. Lad hvert projekt
      have egne kvalitetskrav, og rediger dem i UI.
- [ ] **Oversæt rubric-kriterier.** Kriterie-teksterne er engelske i et ellers dansk UI
      (de er det kritikeren scorer på — hold en engelsk kopi til modellen).
- [ ] **Per-projekt team-config.** Team-roster er statisk/display-only. Lad et projekt
      vælge foretrukken topologi/agents.
- [ ] **Reject-and-revise i core.** Verificér/byg `humanGate → builder`-edge så en
      afvisning med noter kan trigge én runde mere (UI har allerede "Revise with notes").
- [ ] **Token-/cost-tracking.** Vis forbrug pr. opgave/projekt; evt. budget-advarsel.
- [ ] **Søg + gruppér i sidebar.** Søgefelt over "Seneste opgaver" (listen er global nu);
      evt. gruppér pr. projekt.
- [ ] **Tæl-badges på filtre.** Live 2 · Gate 1 · osv.

## 🟢 Nice to have

Forbedringer og fremtid.

- [ ] Hover-preview af seneste draft/verdict på en opgave i sidebaren.
- [ ] Aggregeret bund-statuslinje: antal projekter · kørende nu · tokens i dag.
- [ ] "Kørende nu"-sektion der pinner live-opgaver øverst.
- [ ] Eksportér artifact (Markdown/PDF) fra run-siden.
- [ ] Keyboard-shortcuts cheat-sheet (A/R/G, J/K, ⌘↵).
- [ ] Fuld i18n-toggle (dansk/engelsk) i stedet for hårdkodet dansk.
- [ ] Tema / lys-mode.
- [ ] Slack/Mattermost-relay af SSE-streamen.
- [ ] Realtime-dashboard via Supabase Realtime.

---

## 🐛 Kendte issues / teknisk gæld

- [ ] **Dev-shell Node-mismatch.** `pnpm`/corepack crasher på Node 18 i shellen;
      `turbo run dev` skal køre på Node 22. Pin Node (`.nvmrc`/`engines`) eller dokumentér.
- [ ] **API-dev har ingen watch.** `apps/api` kører via `tsx src/main.ts` uden watch —
      ændringer i api/shared kræver manuel genstart. Overvej `tsx watch`.
- [ ] **CORS-metoder.** `main.ts` tillader kun `GET, POST` — `PATCH`/`DELETE` virker kun
      fordi web kalder via server-proxy. Ret listen eller dokumentér antagelsen.
- [ ] **To "seneste opgaver".** Composeren viser projekt-scopede seneste opgaver, sidebaren
      en global liste. Afklar om begge skal blive.
- [ ] **Per-task repo-override fjernet (bevidst).** Ingen måde at køre én opgave mod et
      andet repo end projektets uden at skifte projektets repo.
- [ ] **Ingen web-auth.** `AGENT_API_KEY` holdes server-side via proxy (fint for internt),
      men web-appen har ingen bruger-login/adgangskontrol.

---

## 🧭 Epics / større temaer

### 🌙 Autonome missioner (se §5 i [design-brief.md](design-brief.md))

Inkrementel køreplan, hvert trin skal kunne shippes for sig:

- 🚧 **1. Backlog som data.** Schema + store leveret (2026-06-17): `missions` +
      `backlog_items` med `priority`, `status`, `dependsOn`, `risk`, `verification`,
      mission-link; `BacklogStore` injiceret i core. **Mangler:** API-endpoints + UI til at se/redigere.
- [ ] **2. Self-challenge-node.** Efter en accepteret leverance foreslår en
      planner/kritiker næste backlog-punkter (menneske-reviewet først).
- [ ] **3. Mission-entitet + manuel-tick runner.** En `mission` med et mål; en runner
      der på tryk tager ét punkt, kører det, gemmer, foreslår næste — menneske i loopet.
- [ ] **4. Auto-loop + guardrails.** Runner looper under budget/tid/konvergens med
      kill switch; menneske-checkpoints bliver asynkrone.
- [ ] **5. Tester/QA-agent + git-worktrees.** Rigtig verifikation (build/test) og
      isoleret parallel eksekvering.
- [ ] **6. Overnight-scheduling + tempo-kontrol** (arbejdsvinduer, max parallelle
      agenter, genoptag-ved-boot).
- [ ] **7. Async review-kø-UI.** Milepæle, blockers, kill switch, live mission-dashboard.

### Øvrige temaer

- [ ] **Løft `@arzonic/agent-core` ind i Ranky/Bravy** (eller publicér pakken) — "run once,
      serve everywhere" via `@arzonic/agent-client`.
- [ ] **Multi-tenant / brugere & roller** hvis appen skal ud over én intern bruger.
- [ ] **Observability**: strukturerede logs, kørsels-metrics, LangSmith-traces linket fra UI.
- [ ] **Deploy af web-appen** (i dag kun api via PM2): byg og host Next-appen + miljø-secrets.
