# Agent Engine — Backlog

> Levende dokument. Her står hvad vi mangler at lave og hvilke features der kunne
> komme. Opdatér den løbende: kryds af, flyt punkter mellem sektioner, og log
> leverede ting under **Senest leveret**.

**Sidst opdateret:** 2026-06-17

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

## 🗺️ Store milepæle (overblik)

Det store perspektiv — fra nu til Nordstjernen. Detaljerne lever i tiers + epics nedenfor.

- [x] **M0 — Fundament & web.** Multi-agent team (4 grafer), projekt-hukommelse,
      projekt-først web-app. *(leveret)*
- [x] **M1 — Missions-motoren.** Autonom loop der planlægger, kører, verificerer,
      genplanlægger, parkerer risiko, stopper sikkert og kan overvåges. = design-brief §6,
      Trin 1–8. *(leveret — API + worker + dashboard)*
- [ ] **M2 — Fra motor til byg.** Skrive-capable eksekvering i worktrees + parallelisme —
      springet fra "laver en plan" til "laver kørende kode". *(Phase 5)*
- [ ] **M3 — Kvalitet & tillid.** Dybere verifikation/tests, konvergens-tuning, drift over
      mange timer (cost/retries), tillids-UX (diffs, digest, kurskorrektion). *(Phase 5)*
- [ ] **M4 — Produktisering.** Løft core ind i Ranky/Bravy, multi-tenant, deploy af
      web-appen. *(se Øvrige temaer)*

## Sådan bruger du den

- `- [ ]` = ikke startet · `- [x]` = færdig · `🚧` = i gang · `🔒` = blokeret.
- Når et punkt er færdigt: sæt `[x]`, og flyt det op under **Senest leveret** med dato.
- Prioritet: **Must have** (kan ikke undværes) → **Need to have** (vigtigt, næste runde)
  → **Nice to have** (forbedringer / fremtid).
- Hold punkterne små nok til at kunne afsluttes i én PR. Store ting ligger under **Epics**.

---

## ✅ Senest leveret

### 2026-06-18 — M2 Trin 4: WorkRunner i worktree (motoren forfatter nu kode)
- [x] `createWorktreeWorkRunner` i core ([packages/core/src/runner.ts](../packages/core/src/runner.ts)):
      pr. item → provisioner worktree (Trin 2) → valgfri `prepare` (deps) → kører en per-worktree graf
      (genbruger `createGraphWorkRunner` til drift + gate) → returnerer `WorkResult.worktree`.
- [x] `createImplementerGraph` ([packages/core/src/graph.ts](../packages/core/src/graph.ts)): minimal
      mission-eksekverings-graf (implementer-node → END, ingen human-gate) rodfæstet i worktree'et via `WritableRepoTools`.
- [x] **Verifier dømmer den forfattede kode:** `Verifier.run(checks, cwd?)` — controlleren sender
      `result.worktree` som cwd, så checks kører i worktree'et, ikke det urørte hoved-repo. Bagudkompatibelt.
- [x] `installWorktreeDeps()` ([packages/shared/src/checks.ts](../packages/shared/src/checks.ts)):
      `pnpm install` pr. worktree (delt content-addressable store → billigt på disk efter første). Lang timeout.
- [x] **Mission-worker wired** ([apps/api/src/mission-worker.ts](../apps/api/src/mission-worker.ts)): worktree-runner +
      implementer-graf + deps-install + worktree-verifikation pr. item. Branch `mission/<id>/item/<itemId>`.
- [x] Bevist ([packages/core/verify-worktree-runner.ts](../packages/core/verify-worktree-runner.ts), 8 checks mod et rigtigt git-repo):
      koden forfattes isoleret i worktree'et, hoved-repo urørt, og Verifier **passer i worktree** men **fejler i hoved-repo** →
      bevis for at den dømmer det rigtige sted. `turbo build` grøn (6/6).

### 2026-06-18 — M2 Trin 3: Implementer-node (ReAct-loop der skriver kode)
- [x] Dedikeret `implementer`-node i core ([packages/core/src/nodes/implementer.ts](../packages/core/src/nodes/implementer.ts))
      bygget på prebuilt `createReactAgent` (mindre kode, lavere risiko end håndrullet loop) —
      ægte agentisk ReAct-loop, `recursionLimit`-termineret (~24 tool-runder), fanger ikke-konvergens pænt.
- [x] Tool-belt = læse-tools (som analyst) **+ write-tools** (`write_file`/`apply_edit`/`delete_file`/`run_command`)
      der wrapper en injiceret `WritableRepoTools`. Noden tager `WritableRepoTools` → write-evne
      kan **ikke** lække ind i builder/worker (tekst-only nodes får aldrig et write-capable objekt).
- [x] `buildImplementerTools()` eksporteret separat (testbar glue); ny `implementer`-rolle i
      AgentMessage-enum + `AgentRole` (client) + run-side-styling.
- [x] Bevist ([packages/core/verify-implementer.ts](../packages/core/verify-implementer.ts), 12 checks)
      med en **scripted fake tool-calling model** (ingen API-nøgle): ægte end-to-end hvor loopet
      skriver+redigerer+verificerer en fil på disk, final summary → `draft`, tokens summeres, trace bygges. `turbo build` grøn (6/6).

### 2026-06-17 — M2 Trin 2: Worktree-manager (isoleret arbejde pr. item)
- [x] Ny `WorktreeManager`-interface i core ([packages/core/src/worktree.ts](../packages/core/src/worktree.ts)):
      `create`/`remove`/`list`/`prune` — pure søm (ingen git/fs/`Date.now()`), injiceres som BacklogStore/Verifier.
      Branch-navne sendes **ind** af kalderen (deterministisk fra mission/item-ids) → core forbliver klok-fri + resume-safe.
- [x] `createWorktreeManager(repoPath)` i shared ([packages/shared/src/worktree.ts](../packages/shared/src/worktree.ts)):
      `git worktree`-drevet, én worktree pr. item på egen branch (`<root>/.agent-worktrees/<id>`).
      **Idempotent create** (resume genbruger eksisterende worktree m. arbejde intakt), force-remove (+ valgfri branch-sletning),
      og `prune` der rydder forældreløse entries efter crash. Git spawnes uden shell; usikre ids afvises.
- [x] Symlink-robust: realpather repo-roden (macOS `/var`→`/private/var`) så `list()` matcher git's resolvede stier.
- [x] Bevist ([packages/shared/verify-worktree.ts](../packages/shared/verify-worktree.ts), 15 checks mod et rigtigt temp-repo):
      isolation mellem worktrees + main, idempotent resume bevarer arbejde, prune efter crash, branch-sletning. `turbo build` grøn (6/6).

### 2026-06-17 — M2 Trin 1: Write-laget i RepoTools (springet mod kørende kode)
- [x] Ny `WritableRepoTools extends RepoTools` i core ([packages/core/src/tools.ts](../packages/core/src/tools.ts)):
      `writeFile` / `applyEdit` / `deleteFile` / `runCommand` — **separat interface**, ikke optional
      metoder, så read-only flows (task/builder/analyst) får et objekt **uden** write-metoder → writes
      kan ikke lække ind i ikke-mission-kørsler (strukturel garanti).
- [x] `createWritableRepoTools(root)` i shared ([packages/shared/src/repoTools.ts](../packages/shared/src/repoTools.ts)):
      writes path-confined af samme `within()`-sandbox som læsning; `applyEdit` kræver **unik** match
      (fejler på 0/≥2 forekomster + no-op) → ingen stille fejledit; `writeFile` opretter parent-dirs (cap 1 MB).
- [x] `runAllowedCommand()` ([packages/shared/src/checks.ts](../packages/shared/src/checks.ts)): allowlistet
      eksekverbar, **`shell: false` + array-args** → `&&`/pipe/`$(...)` er inert; bare navne (path-separator afvist),
      cwd = root, hard timeout. `REPO_ALLOWED_COMMANDS` (default `git,node,pnpm,npm,npx`) i env + `.env.example`.
- [x] Bevist ([packages/shared/verify-repo-write.ts](../packages/shared/verify-repo-write.ts), 19 checks):
      write/edit/delete inde i roden, sandbox-escape afvist, runCommand kun allowlistet + ingen shell-interpolation,
      og read-only-factory eksponerer **ingen** write-metoder. `turbo build` grøn (6/6).

### 2026-06-17 — Projekt-først UX: Opgave|Mission-toggle, missioner under projektet
- [x] Segmented toggle (**Opgave | Mission**) i projekt-composeren ([apps/web/app/page.tsx](../apps/web/app/page.tsx)) —
      ét sted at vælge kørsels-mode, begge inden for projektets kontekst (repo + hukommelse).
- [x] `MissionComposer` ([apps/web/app/components/MissionComposer.tsx](../apps/web/app/components/MissionComposer.tsx)):
      arver projektets repo (kræver et repo — verifikationskilden), mål + acceptkriterier + start-backlog + budget.
- [x] Projektet viser nu både **Seneste opgaver** og **Missioner** ([ProjectMissions](../apps/web/app/components/ProjectMissions.tsx)).
- [x] Fjernet det separate "Missioner"-ø-link i railen → rydder "tre ting"-forvirringen; projekt er den ene container.
      `turbo build` grøn (6/6).

### 2026-06-17 — Missioner Trin 8b: Mission-dashboard (M1 i mål 🎉)
- [x] `/missions`: liste + opret-mission (projekt, repo, mål, acceptkriterier, start-backlog, budget).
- [x] `/missions/:id` dashboard ([apps/web/app/missions/](../apps/web/app/missions/)): live via SSE-snapshots
      (`EventSource`), status + budget-burn-bar, digest-tællere, backlog-board grupperet pr. status.
- [x] Parkerede items vises øverst ("Afventer dig") med **Godkend/Afvis** (async decision-endpoint) + høj-risiko-badge.
- [x] Kill switch (Stop) på kørende missioner; "Missioner"-link i venstre-railen.
- [x] 5 server-proxy-ruter (`/api/missions/*`) holder bearer-key server-side. `turbo build` grøn (6/6).

### 2026-06-17 — Missioner Trin 8a: Mission-API + PM2-worker (rygrad)
- [x] NestJS `MissionsController` ([apps/api/src/missions/](../apps/api/src/missions/)): `POST /missions`,
      `GET /missions`, `GET /missions/:id`, `SSE /missions/:id/stream`, `POST /missions/:id/stop`,
      `POST /missions/:id/items/:itemId/decision` — bag bearer-guarden.
- [x] `MissionsService` wirer `BacklogService` + `classifyRisk`/`buildDigest`/approve-reject; SSE streamer
      periodiske snapshots (backlog-board + budget-burn). DI bekræftet via boot-test.
- [x] `BACKLOG`-provider (degraderer pænt uden `SUPABASE_DB_URL`); mission-env i shared + `.env.example`.
- [x] **PM2 mission-worker** ([apps/api/src/mission-worker.ts](../apps/api/src/mission-worker.ts)): separat proces,
      deler Postgres, driver `runMission` for kørende missioner serielt. Tilføjet til `ecosystem.config.cjs`.
- [x] Client-wire-typer + metoder (`createMission`/`list`/`get`/`stop`/`decideMissionItem`/`streamMission`). `turbo build` grøn (6/6).
- [ ] **Mangler (Trin 8b):** mission-dashboard i web-appen (backlog-board, live-aktivitet, budget, parkerede items, digest).
- [ ] **Note:** work-items kører i dag gennem project/team-grafen (planlægning + verifikation). Skrive-capable
      eksekvering i repoet (rigtige kodeændringer) er M2 — missionen planlægger + verificerer, men forfatter endnu ikke kode på disk.

### 2026-06-17 — Missioner Trin 7: Human-policy (park-risk, kør resten, blokér aldrig)
- [x] `classifyRisk()` i core ([packages/core/src/humanPolicy.ts](../packages/core/src/humanPolicy.ts)):
      statiske high-risk-mønstre (deploy/delete/payment/secrets…) + planner-flag + host-mønstre.
- [x] Controller-loopet **parker high-risk items før kørsel** som `blocked_needs_human` og går videre —
      intet irreversibelt kører uovervåget; mennesket blokerer aldrig loopet.
- [x] `approveParkedItem` (rydder risk + re-queue) / `rejectParkedItem` (→ failed) til async-beslutning.
- [x] `buildDigest()`: done/parked/failed/next/spend-rollup (§5.5 morgendigest).
- [x] Log-først `createConsoleNotifier()` i shared ([packages/shared/src/notifier.ts](../packages/shared/src/notifier.ts))
      + `item_parked`-event. Bevist ([verify-human-policy.ts](../packages/core/verify-human-policy.ts) + loop-test): `turbo build` grøn.

### 2026-06-17 — Missioner Trin 6: Governors-hardening (thrash-guard)
- [x] Thrash-guard i controller-loopet ([packages/core/src/controller.ts](../packages/core/src/controller.ts)):
      et item der fejler `thrashLimit` gange (default 3) **parkes** som `blocked_needs_human` —
      ikke retried i det uendelige, og missionen stopper ikke; den går videre til andet arbejde.
- [x] Parkering tæller som fremskridt (nulstiller no-progress) → en mission med kun parkerede items
      ender rent i `blocked`, ikke `stopped`. (Budget/deadline/iterations/no-progress/kill switch kom i Trin 4.)
- [x] Bevist ([packages/core/verify-mission.ts](../packages/core/verify-mission.ts), nu 14 checks):
      thrash parker det stukne item, andet arbejde fuldføres stadig, ingen uendelig loop. `turbo build` grøn.

### 2026-06-17 — Missioner Trin 5: Replan-agent (lead)
- [x] `makeReplanner(model)` i core ([packages/core/src/nodes/replan.ts](../packages/core/src/nodes/replan.ts)):
      ud fra mål + deliverable + verifikation beslutter den item-status (done/todo/failed/blocked_needs_human)
      + foreslår follow-ups (med risk), erstatter `defaultReplanner`.
- [x] **Sandhedsregel i kode** (`applyReplanGuards`): et item kan kun blive "done" hvis Verifier bestod —
      ellers tvunget tilbage til `todo`. Modellen kan aldrig wave en fejlende build igennem (jf. critic's pass-regel).
- [x] Replan-tokens foldes ind i mission-budgettet (`ReplanDecision.tokensUsed`).
- [x] Bevist ([packages/core/verify-replan.ts](../packages/core/verify-replan.ts)): done kræver pass, high-risk-parking
      og follow-ups bevares. `turbo build` grøn.

### 2026-06-17 — Missioner Trin 4: runMission controller-loop (pure core)
- [x] `runMission(deps, missionId)` i core ([packages/core/src/controller.ts](../packages/core/src/controller.ts)):
      henter næste actionable item → kører via WorkRunner → verificerer → replan → opdaterer backlog, til mål/governor.
- [x] Injicerede sømme: `Replanner` (+ `defaultReplanner`, Trin 5-stub), `Notifier` (Trin 7),
      `Clock` (ingen `Date.now()` i core), `MissionGovernors`.
- [x] Provably terminerende: max-iterations, token-budget, no-progress, deadline + kill switch
      (mission-status ≠ running stopper). Resume: crashed `in_progress`-item requeues.
- [x] Bevist ([packages/core/verify-mission.ts](../packages/core/verify-mission.ts)) med in-memory fakes (12 checks):
      prioritet+dependsOn-rækkefølge, done-afslutning, deadlock→blocked, alle governors, resume, kill switch. `turbo build` grøn.

### 2026-06-17 — Missioner Trin 3: WorkRunner (ét backlog-item gennem grafen)
- [x] `WorkRunner`-interface + `WorkItem`/`WorkResult` i core ([packages/core/src/runner.ts](../packages/core/src/runner.ts)).
- [x] Ren adapter `createGraphWorkRunner(graph)`: kører item under `thread_id = item.id`
      (checkpointet pr. item), bygger task af context+title+detail, **auto-passerer
      human-gaten** (missioner blokerer aldrig — Verifier afgør "done"), læser deliverable fra checkpoint.
- [x] Bevist ([packages/core/verify-runner.ts](../packages/core/verify-runner.ts)) med fake-graf:
      thread_id-wiring, gate-resume, ingen busy-loop, resultat-udtræk. `turbo build` grøn.

### 2026-06-17 — Missioner Trin 2: Verifier (pass/fail = sandheden for "done")
- [x] `Verifier`-interface + `VerifierReport` i core ([packages/core/src/verifier.ts](../packages/core/src/verifier.ts)).
- [x] `createVerifier(repoPath)` i shared ([packages/shared/src/verifier.ts](../packages/shared/src/verifier.ts)):
      kører allowlistede checks, `passed` udledt af rigtig exit-kode (ikke LLM).
- [x] Delt check-runner ([packages/shared/src/checks.ts](../packages/shared/src/checks.ts)) som
      både `RepoTools.runCheck` og Verifier bruger → pass/fail kan ikke divergere.
- [x] Bevist ([packages/shared/verify-verifier.ts](../packages/shared/verify-verifier.ts)):
      exit 0 ⇒ passed, exit 1 ⇒ failed, ukendt/ingen check ⇒ aldrig stille pass. `turbo build` grøn.

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
- [ ] **Udvid rubric / Definition of Done (trinvis).** Basis altid på som gulv;
      adaptivitet + per-projekt ovenpå. De 3 påkrævede (korrekt/komplet/rammer-opgaven)
      er universelle og bør aldrig kunne vælges fra.
  - [ ] a. **Per-projekt rubric** — hvert projekt har egne kvalitetskrav (override af
        global `defaultRubric`), redigerbare i UI. Forudsigeligt, mennesket styrer.
  - [ ] b. **Adaptive ekstra-krav** — router/arkitekt *foreslår* opgave-relevante
        kriterier oven på basen (kode → "fejl-tilfælde håndteret", API → "ingen breaking
        changes"). Tilføjer kun, fjerner aldrig basen; mennesket kan se/justere forslag.
  - [ ] c. **Hård verifikation binder rubric (missioner)** — for kode er "done" = rigtige
        checks (test/lint/build) via Verifier-laget + rubric, ikke kun LLM-score.
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

### 🌙 M1 — Missions-motoren (design-brief §6, 8 trin)

Build-order, hvert trin shippes + bevises for sig:

- [x] **1. Schema + BacklogStore** — `missions` + `backlog_items`, injiceret i core.
- [x] **2. Verifier** — pass/fail fra rigtige checks (ikke LLM) er sandheden for "done".
- [x] **3. WorkRunner** — kør ét item gennem project/team-grafen, checkpointet pr. item.
- [x] **4. Controller-loop** (`runMission`) — pick → run → verify → replan → loop, med resume.
- [x] **5. Replan-agent** (lead) — mål + resultat + verifikation → opdater backlog.
- [ ] **6. Governors + kill switch** — budget/deadline/iterationer/no-progress/thrash +
      stop-endpoint. *(næste)*
- [ ] **7. Human-policy** — risk-parking (blokér aldrig loopet) + async decision + `Notifier`.
- [ ] **8. Mission-API + PM2-worker + dashboard** — `POST /missions` m.fl., baggrunds-worker,
      backlog-board / live aktivitet / digest. *(i gang)*

### 🛠️ M2 — Fra motor til byg (Phase 5, efter Trin 8)

Mål: agenter skriver rigtige filer + kører kommandoer i isolerede git-worktrees, så
Verifier validerer **faktisk forfattet kode** — og flere workers kan køre parallelt
uden at træde på hinanden. Springet fra "laver en plan" til "laver kørende kode".

Build-order (shippet + bevist pr. trin, som M1):

- [x] **1. Write-laget i RepoTools** — `writeFile` / `applyEdit` / `deleteFile` /
      `runCommand`, path-confined til `REPO_ALLOWED_ROOTS`. (`tools.ts` + `repoTools.ts`)
- [x] **2. Worktree-manager** (injiceret søm i `shared`, som BacklogStore/Verifier) —
      worktree pr. item på en mission-branch, oprydning + `git worktree prune` ved crash.
- [x] **3. Implementer-node med write-tools** — dedikeret `implementer`-node bygget på
      prebuilt `createReactAgent` (ReAct-loop, `recursionLimit`-termineret). Tager
      `WritableRepoTools` → write-tools kan **ikke** lække ind i builders tekst-opgaver
      (read-only nodes får aldrig et objekt med write-metoder). ([implementer.ts](../packages/core/src/nodes/implementer.ts))
- [x] **4. WorkRunner i worktree** — `createWorktreeWorkRunner` (+ `createImplementerGraph`)
      provisioner worktree pr. item, kører implementeren rodfæstet dér, og `Verifier.run(checks, cwd)`
      checker den forfattede kode i worktree'et. Deps via `installWorktreeDeps` (pnpm, delt store).
      Mission-worker wired. (`runner.ts` + `graph.ts` + `verifier.ts`)
- [ ] **5. Integration + verificér-efter-merge** — verify i worktree → merge mission-branch
      → **re-verify på mission-branch** (to grønne items kan summe til rød main). Konflikt →
      park `blocked_needs_human`.
- [ ] **6. Parallelisme** *(egen epic, sidst, konservativt)* — N actionable items samtidigt,
      hver i egen worktree. Lead tildeler **ikke-overlappende fil-scopes**, ellers merge
      **sekventielt** (rebase næste på forrige). Start med seriel-i-worktrees (1–5).

Sikkerheds-invarianter:

- Path-sandbox (`within()`) gælder også writes — ingen escape fra worktree-roden.
- **`runCommand` er IKKE dækket af path-sandbox** (M2's #1 risiko): allowliste eksekverbare
  **uden shell-interpolation** (ingen `&&` / pipe / `$(...)`), cwd = worktree; OS-isolation
  (container/nsjail) på sigt. High-risk → `classifyRisk` parkerer (jf. `humanPolicy.ts`).
- `classifyRisk` inspicerer **tool-kaldene**, ikke kun item-titlen (kommando udenfor
  allowliste, pakke-installs, edits til CI/deploy/secrets/migrations → high).
- Core ren: worktree-manager injiceres; branch-navne/timestamps sendes ind (ingen
  `Date.now()` i core). "Done" = Verifier-pass før **og** efter merge.
- Deps: beslut delt pnpm-store/symlink vs. install pr. worktree (perf/disk) før Trin 4.

Build-vs-adopt (LangChain):

- **`createReactAgent`** (`@langchain/langgraph` prebuilt) — overvej til implementer-loopen
  (Trin 3) frem for at håndrulle endnu en loop som analyst. Lavere risiko, mindre kode.
- **`deepagents`** (LangChain's "deep agent"-scaffold: planning-todo + subagents + virtuel
  FS) — **mine patterns, men adoptér ikke som motor.** Vores backlog (Postgres),
  Verifier-som-sandhed, governors og core-pure er bevidst stærkere/mere persistente end
  deepagents' in-state todo + virtuelle filsystem (vi vil have *rigtige* filer + *rigtige*
  checks). Lån fra det:
  - **Sub-agent / kontekst-isolation** til parallelle workers (M2 Trin 6) — hver worker
    sit eget kontekst-vindue, så de ikke forurener hinanden.
  - **Filsystem-tool-interfacet** som inspiration til write-laget — men vi vil have
    **disk + git-worktree**, ikke deepagents' virtuelle (in-state) FS.
  - **Planning-mønstret** — men kun som inspiration; vores **persistente backlog er
    allerede et niveau over** en todo-liste i kontekst.

### 🤝 M3 — Kvalitet & tillid (Phase 5)

- [ ] **Dybere verifikation.** Agent-genererede tests / e2e, så "grøn build" er en stærk
      sandhed — ikke kun lint/build.
- [ ] **Konvergens-kvalitet.** Bedre dekomponering, undgå thrash, vide hvornår "godt nok" på
      åbne mål — tuning + evals.
- [ ] **Drift over mange timer.** Cost/budget i skala, model-valg, caching, rate-limit-retries,
      fejl-recovery.
- [ ] **Tillids-UX.** Diffs man kan godkende/afvise, morning digest, kurskorrektion undervejs.

### Øvrige temaer (M4 — produktisering)

- [ ] **Løft `@arzonic/agent-core` ind i Ranky/Bravy** (eller publicér pakken) — "run once,
      serve everywhere" via `@arzonic/agent-client`.
- [ ] **Multi-tenant / brugere & roller** hvis appen skal ud over én intern bruger.
- [ ] **Observability**: strukturerede logs, kørsels-metrics, LangSmith-traces linket fra UI.
- [ ] **Deploy af web-appen** (i dag kun api via PM2): byg og host Next-appen + miljø-secrets.
