# Agent Engine — Backlog

> Levende dokument. Her står hvad vi mangler at lave og hvilke features der kunne
> komme. Opdatér den løbende: kryds af, flyt punkter mellem sektioner, og log
> leverede ting under **Senest leveret**.

**Sidst opdateret:** 2026-06-23

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
- [x] **M2 — Fra motor til byg.** Skrive-capable eksekvering i worktrees + parallelisme —
      springet fra "laver en plan" til "laver kørende kode". *(leveret — write-tools, worktrees,
      implementer-node, worktree-runner, integration+verify-after-merge, parallelisme)*
- [x] **M3 — Kvalitet & tillid.** Dybere verifikation/tests, konvergens-tuning, drift over
      mange timer (cost/retries), tillids-UX (diffs, digest, kurskorrektion). *(leveret — alle 6 trin)*
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

### 2026-06-28 — Gemini via Vertex AI (ADC, ingen API-nøgle) + konkrete team-modeller
- [x] **Gemini uden API-nøgle (Vertex AI + ADC).** `buildModel` ([llm.ts](../packages/shared/src/llm.ts))
      router nu `provider=google` gennem `ChatVertexAI` (`@langchain/google-vertexai`) når
      `GOOGLE_CLOUD_PROJECT` er sat — autentificeret via Application Default Credentials
      (`gcloud auth application-default login` / service-account), **ingen nøgle**. Falder tilbage til
      den nøgle-baserede `ChatGoogleGenerativeAI` når kun `GOOGLE_API_KEY` er sat. Begge er
      `BaseChatModel`'er der ruter gennem `this.caller`, så retry-policy + per-rolle-temperatur +
      structured-output/ReAct-wiring er identiske uanset rute.
- [x] **Env + gates.** Ny `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` (default `europe-west4`)
      i [env.ts](../packages/shared/src/env.ts); superRefine accepterer en google-rolle hvis **enten**
      nøgle **eller** projekt er sat. Server-side provider-gates ([role-models.util.ts](../apps/api/src/role-models.util.ts),
      [settings.service.ts](../apps/api/src/settings/settings.service.ts)) og [SettingsModal](../apps/web/app/components/SettingsModal.tsx)
      ("Mangler nøgle eller ADC") afspejler det. Default google-model løftet `gemini-2.0-flash` → `gemini-2.5-flash`.
- [x] **Konkrete team-modeller (ingen implicit "Standard").** [TeamModelPicker](../apps/web/app/components/TeamModelPicker.tsx)
      gemmer altid et konkret model-id — at vælge en provider vælger dens anbefalede (først-listede) model,
      så det du ser er præcis det der kører. Gammel config uden pinned model falder pænt tilbage til provider-anbefalingen.
- [x] **Team-roster opdateret** ([format.ts](../apps/web/app/lib/format.ts)): Udvikler/Kritiker (core) +
      Planlægger/Arkitekt/Tester/Lead/Koordinator (extra) — matcher de faktiske mission-roller.
- [x] Bevist (live): [verify-vertex-live.ts](../packages/shared/verify-vertex-live.ts) — et rigtigt Vertex-kald via
      ADC (skipper rent uden `GOOGLE_CLOUD_PROJECT`). `turbo build` grøn (6/6).

### 2026-06-24 — 🌙 Nordstjerne-gap lukket: de 4 "stol-på-den-natten-over"-blockere
Et multi-agent audit (verificeret mod kildekoden, ikke backlog-afkrydsningerne) fandt fire
blokerende huller mellem "M3 afkrydset" og "kører uovervåget natten over". Alle fire er nu lukket:
- [x] **Blocker 1 — out-of-band notifikation (overvågeren kan nås mens den sover).** Ny
      `createWebhookNotifier` ([notifier.ts](../packages/shared/src/notifier.ts)): POSTer `{ text, event }`
      pr. event (Slack/Discord/Mattermost incoming webhooks virker direkte; `text`-feltet). Default kun de
      menneske-relevante events (`item_parked` / `mission_digest` / `mission_stopped`), best-effort (en
      leveringsfejl kastes aldrig ind i loopet). Wired i workeren via `createConsoleNotifier({ also: [...] })`
      bag `MISSION_NOTIFY_WEBHOOK_URL`. Plus en **planlagt mid-run digest** (`MISSION_DIGEST_INTERVAL_MS`) på
      egen timer — en mission der stadig kører om morgenen rapporterer *før* den slutter, ikke kun ved exit.
- [x] **Blocker 2 — preemptiv kill switch/deadline.** Workeren bygger nu en `AbortController` pr. mission +
      en **watcher** ([mission-worker.ts](../apps/api/src/mission-worker.ts)) der hvert `MISSION_ABORT_POLL_MS`
      genlæser status/deadline/budget og **aborter den igangværende kørsel** — signalet flyder gennem
      `runMission → runner → graf-modelkald` (sømmet fandtes, var bare aldrig wired). Core fik en ren
      `aborted`-outcome ([controller.ts](../packages/core/src/controller.ts)): et afbrudt item **re-queues til
      todo** (resume-sikkert), parkeres aldrig som fejl, og loopets næste top stopper missionen med rigtig grund.
      Stop kan ikke længere kun bide mellem batches. **UI:** deadline-felt i
      [MissionComposer](../apps/web/app/components/MissionComposer.tsx) (var kun token-budget før).
- [x] **Blocker 3 — strategisk re-decompose (missionen selv-dirigerer).** Når backloggen tømmes men målet
      måske ikke er nået, kalder controlleren nu `Decomposer` igen med `continuation: true` + alle hidtidige
      titler ([controller.ts](../packages/core/src/controller.ts) / [decompose.ts](../packages/core/src/nodes/decompose.ts)) —
      planlægger næste skive arbejde mod målet, eller returnerer **tom** liste ⇒ ægte "done". Bounded af
      `MISSION_MAX_STRATEGIC_REPLANS` (+ alle øvrige governors). Default 0 i core (off, bagudkompat); workeren
      slår den til. Før: en drænet backlog endte straks "done", uanset målet.
- [x] **Blocker 4a — termineringsgaranti overlever genstart.** `iterations` + `no_progress` persisteres nu på
      `missions`-rækken ([backlog.ts](../packages/shared/src/backlog.ts) + [mission.ts](../packages/core/src/mission.ts));
      controlleren seeder dem fra rækken ved resume og skriver dem tilbage hver runde. Før: in-memory tællere
      nulstilledes ved hver PM2-genstart, så en thrashing mission gen-tjente hele sit budget i det uendelige.
- [x] **Blocker 4b — fuld-stak live E2E (artefakt).** [smoke-mission-full.ts](../packages/core/smoke-mission-full.ts)
      driver den *præcise* produktions-stak (decompose-fra-tom → team m. kritiker → tester → integrate → differ →
      strategic re-plan) med en live model mod et throwaway-repo — den komposition der aldrig var kørt samlet
      (gamle [smoke-mission.ts](../packages/core/smoke-mission.ts) kørte den nøgne implementer). Live-harness
      (kræver API-nøgle, koster tokens) ⇒ ikke i CI; **køres manuelt** for at omsætte "alle søm grønne" til
      "stakken bærer vand".
- [x] Bevist (hermetisk): [verify-blockers.ts](../packages/core/verify-blockers.ts) (14 checks — abort-requeue
      vs. park-kontrast, strategic re-plan konvergerer + er off ved 0, tæller-persistens over simuleret genstart)
      \+ [verify-notifier.ts](../packages/shared/verify-notifier.ts) (10 checks — webhook-payload, event-filter,
      fejl-swallow, `also`-fan-out). `turbo build` grøn (6/6); alle controller-harnesses (mission/decompose/drift/replan) stadig grønne.

### 2026-06-23 — M3 Trin 6: Morgendigest + kurskorrektion (M3 i mål 🎉)
- [x] **Guidance (kurskorrektion ud over Stop):** nyt `guidance`-felt på missionen
      ([mission.ts](../packages/core/src/mission.ts) + DB-kolonne). `PATCH /missions/:id/guidance`
      ([missions.controller.ts](../apps/api/src/missions/missions.controller.ts)) sætter fri-tekst på en **ikke-terminal**
      mission; replan- og decompose-prompterne ([replan.ts](../packages/core/src/nodes/replan.ts) /
      [decompose.ts](../packages/core/src/nodes/decompose.ts)) væver den ind som "Operator guidance". Controlleren
      gen-læser missionen hver loop-runde, så en styring sat midt i kørslen fanges ved næste planlægning. **Standing**
      (ikke one-shot): styrer hver efterfølgende runde til den ændres/ryddes. UI: et "Styring"-panel på dashboardet.
- [x] **Rigere morgendigest:** `buildDigest` ([humanPolicy.ts](../packages/core/src/humanPolicy.ts)) ruller nu også
      **`blocked`** (parkerede items + *hvorfor*), **`nextHighRisk`** (kommende høj-risiko-arbejde) og **`recent`**
      (seneste aktivitet) op. Leveret via `Notifier` som et nyt **`mission_digest`-event** i controllerens `stop()` —
      **også når et menneske trykker Stop** (kill-switch-exit ruter nu gennem `stop()`, ikke et bart return). Console-
      notifieren rendrer digesten; dashboardet viser "Næste høj-risiko" + foresight.
- [x] Bevist: [verify-human-policy.ts](../packages/core/verify-human-policy.ts) udvidet (blocked-med-grund,
      nextHighRisk, recent-orden) + [verify-replan.ts](../packages/core/verify-replan.ts) (guidance optræder verbatim i
      replan-prompten; ingen guidance ⇒ ingen sektion) + [verify-mission.ts](../packages/core/verify-mission.ts)
      (digesten leveres på menneske-Stop). `turbo build` grøn (6/6); alle M3-harnesses + API-smoke grønne. Reviewet
      adversarielt: rettede den manglende digest-levering på Stop.

### 2026-06-23 — M3 Trin 5: Approvable diffs (se hvad motoren skrev)
- [x] **`Differ`-søm i core** ([controller.ts](../packages/core/src/controller.ts) + `DiffResult`/`DiffFile` i
      [mission.ts](../packages/core/src/mission.ts)): pr. item en struktureret diff — ændrede filer (status + ±linjer)
      \+ unified patch — så et menneske kan **se** ændringen før Godkend/Afvis, især på parkerede items. Injiceret som
      de øvrige søm; valgfrit (udeladt ⇒ præcis pre-Trin-5-adfærd).
- [x] **Fanget på det rigtige tidspunkt:** i `runItem` på item'ets **worktree** — efter implementer + tester har
      skrevet, men **før** Verifier kører (så build-artefakter ikke forurener diffen) og før Integratoren committer/merger.
      Samme punkt uanset om item'et ender done eller parkeret, så diffen altid viser hvad der faktisk blev skrevet.
      Best-effort: et git-hik efterlader bare diffen `null`, aldrig en stranded item. Persisteres på item'et i `finalize`.
- [x] **git-impl `createGitDiffer`** ([differ.ts](../packages/shared/src/differ.ts)): `git diff HEAD` (fanger både
      staged og unstaged), untracked filer vist via et midlertidigt `add -N` der **resettes igen** så Integratorens
      senere commit er urørt; gitignored build-output ekskluderes; patch byte-cappet (100 KB) uden at splitte en
      multibyte-char. Rent read-side git-plumbing — Verifier er stadig sandheden for "done".
- [x] **DB + wire + UI:** ny `diff jsonb`-kolonne på `backlog_items` (idempotent ALTER); `BacklogItem.diff` flyder
      gennem detail/SSE; `ApiBacklogItem.diff` i wire-typerne; dashboardet ([missions/[id]](../apps/web/app/missions/[id]/page.tsx))
      rendrer en sammenklappelig diff pr. item (fil-liste + farvet patch), især på parkerede items.
- [x] Bevist: [verify-differ.ts](../packages/shared/verify-differ.ts) (20 checks, rigtigt git-repo —
      modified/added/deleted/empty/staged/gitignore-ekskludering/index-clean/multibyte-trunkering) +
      [verify-mission.ts](../packages/core/verify-mission.ts) udvidet (diff fanget på worktree + persisteret; springes
      over uden worktree; en kastende differ strander ikke item'et). `turbo build` grøn (6/6); integrator + øvrige
      M3-harnesses + API-smoke stadig grønne.
- [x] **Follow-up (perf) — leveret:** SSE-snapshottet sendte alle items' patches hver 2s — uafgrænset i aggregat.
      Nu stripper `detail()`/`snapshot()` ([missions.service.ts](../apps/api/src/missions/missions.service.ts))
      `patch`-feltet (board'et beholder kun fil-resuméet: `files`/`additions`/`deletions`/`truncated`), og patchen
      lazy-loades pr. item ved udfold via `GET /missions/:id/items/:itemId/diff`
      ([controller](../apps/api/src/missions/missions.controller.ts) → `itemDiff` + web-proxy), caches i en
      `Map<itemId, ApiDiff>` med en lille "indlæser…"-tilstand. Wire-typerne urørte (`ApiDiff.patch` er bare `""`
      i board-resuméer). `turbo build` grøn (6/6).

### 2026-06-23 — M3 Trin 4 i mål: per-projekt default-team + redigér en kørende missions team
- [x] **Per-projekt default-team (arv ved oprettelse):** et projekt gemmer sit eget standard-team
      (`projects.settings.roleModels`); en ny mission **arver** det og fletter sine egne valg ovenpå i
      [MissionsService.create](../apps/api/src/missions/missions.service.ts) — `mergeRoleModels(projectDefault, dto.roleModels)`.
      Workeren lægger som før global default (DB) + env nedenunder, så netto-præcedensen bliver **mission > projekt >
      global > env** — **uden at røre mission-workeren** (projekt-laget er foldet ind i `mission.roleModels` ved oprettelse).
- [x] **Redigér en kørende missions team:** `PATCH /missions/:id/role-models`
      ([missions.controller.ts](../apps/api/src/missions/missions.controller.ts) + `updateRoleModels` i servicen) opdaterer en
      **ikke-terminal** missions `roleModels`; træder i kraft ved workerens næste planlægnings-runde (den rebuilder agents
      pr. pass). Terminal mission (done/failed/stopped) afvises med 409.
- [x] **Pure `mergeRoleModels(...layers)`** i core ([models.ts](../packages/core/src/models.ts)) — ordnet shallow-merge,
      senere lag vinder, `undefined`/tomme lag springes over: hele præcedens-stigen ét sted. `MissionPatch` (core + shared)
      får `roleModels`; `backlog.updateMission` mapper `role_models` (jsonb) som de øvrige json-felter.
- [x] **Én server-side provider-gate:** ny `assertProvidersConfigured(env, roleModels)`
      ([role-models.util.ts](../apps/api/src/role-models.util.ts)) som mission-create/update, per-projekt-default **og** den
      globale settings-default alle funnel'er igennem — afviser et team der bruger en provider uden nøgle. Validerer det
      **flettede** resultat, så et dårligt projekt-default fanges ved mission-oprettelse.
- [x] **UI:** team-vælger i [ProjectFormView](../apps/web/app/components/ProjectFormView.tsx) (projektets standard-team)
      + "Team"-knap → modal på mission-dashboardet ([missions/[id]](../apps/web/app/missions/[id]/page.tsx)) der redigerer en
      kørende missions team (delt `TeamModelPicker`). Ny proxy-rute + `UpdateMissionRoleModelsRequest`-wire-type.
- [x] Bevist: [verify-role-models.ts](../packages/core/verify-role-models.ts) udvidet (merge-stigen: mission vinder,
      projekt-/global-/env-only-roller overlever, projekt-default ved tom mission, tomme lag = intet) + shared role-models-
      harness stadig grøn + API-smoke grøn (DI booter med MEMORY-injektion). `turbo build` grøn (6/6).

### 2026-06-23 — M3 Trin 4: Per-rolle temperatur (fx en deterministisk critic)
- [x] **`temperature?` på `ModelSpec`** ([models.ts](../packages/core/src/models.ts), zod 0–2): hver rolle kan nu
      sætte sin egen sampling-temperatur (0 = deterministisk, fx en critic). Rent additivt — udeladt ⇒ runtime-default.
- [x] **Gratis gennem hele stakken:** env `LLM_ROLE_MODELS`, per-mission `missions.role_models` og settings
      `PUT /settings/role-models` validerer alle gennem `RoleModelsConfigSchema`, så temperatur flyder uden ny plumbing.
- [x] **`buildModel` honorerer den pr. provider** ([llm.ts](../packages/shared/src/llm.ts)) — og **dropper den for
      adaptive-only Claude** (Opus 4.7/4.8, Fable), der afviser `temperature ≠ 1` med 400. Det **fixer samtidig en latent
      bug:** den hardkodede `0.2` ville have crashet enhver rolle der kørte Opus 4.8, ved hvert kald.
- [x] **UI:** et kompakt temperatur-input pr. rolle i [TeamModelPicker](../apps/web/app/components/TeamModelPicker.tsx)
      (delt mellem composer + settings); deaktiveret med en hint når den valgte Claude-model ignorerer temperatur.
- [x] Bevist: [verify-role-models.ts](../packages/shared/verify-role-models.ts) udvidet — critic=0 flyder til modellen,
      manglende temp ⇒ default 0.2, Sonnet 4.6 beholder en konfigureret temp, Opus 4.8 **dropper** den, og
      `invocationParams()` kaster ikke længere (latent bug bevist væk). `turbo build` grøn (6/6); cache/retry/role-models-
      harnesses stadig grønne.

### 2026-06-23 — M3 Trin 4: Prompt-caching for Claude (billigere natkørsler)
- [x] **`CachingChatAnthropic`** ([llm.ts](../packages/shared/src/llm.ts)): tynd `ChatAnthropic`-subklasse der
      overrider `invocationParams` og defaulter en top-level **ephemeral** `cache_control`-breakpoint på hvert
      Claude-kald. API'et auto-placerer breakpointet på den sidste cacheable blok og rykker det frem efterhånden
      som samtalen vokser — så den stabile prefix (tools + system + transcript) genbruges fra cache (~0.1x) i
      stedet for at blive genberegnet til fuld pris.
- [x] **Hvorfor en subklasse, ikke `.withConfig`:** basemodellen læser kun `cache_control` fra per-kald-options,
      og `createReactAgent`/`withStructuredOutput` re-binder modellen (taber bound options). En `.withConfig(...)`
      ville desuden returnere en `RunnableBinding` **uden** `bindTools`/`withStructuredOutput`. Subklassen forbliver
      en ægte `ChatAnthropic`, så ReAct-loopet og de strukturerede noder virker uændret — breakpointet flyder gennem
      hvert underliggende kald (inkl. inde i implementer/tester-loopet, hvor gevinsten er størst).
- [x] **Gated + Anthropic-only:** ny `LLM_PROMPT_CACHE` (default **on**, ren cost-reduktion, ingen adfærdsændring;
      slå fra for at måle rå tokens). Kun `case "anthropic"` i [buildModel](../packages/shared/src/llm.ts) bruger den
      — Mistral/Gemini er urørte.
- [x] Bevist: [verify-prompt-cache.ts](../packages/shared/verify-prompt-cache.ts) (11 wiring-checks, ingen nøgle —
      breakpoint injiceres, eksplicit override bevares, `bindTools`/`withStructuredOutput` overlever, andre providers
      urørte) + [verify-prompt-cache-live.ts](../packages/shared/verify-prompt-cache-live.ts) (måler `cache_creation`
      på 1. kald og `cache_read>0` på 2. — skipper rent uden `ANTHROPIC_API_KEY`). `turbo build` grøn (6/6);
      role-models + retry-harnesses stadig grønne.

### 2026-06-20 — M3 Trin 3: Drift-robusthed (overlever natten)
- [x] **LLM-retry (shared):** `isTransientLlmError` + `llmRetryOnFailedAttempt` ([retry.ts](../packages/shared/src/retry.ts))
      klassificerer transiente fejl (429/5xx/408/timeout/netværk) vs. rigtige (4xx/auth/quota/abort). `buildModel`
      ([llm.ts](../packages/shared/src/llm.ts)) bygger hver provider med env-drevet `MISSION_LLM_MAX_RETRIES` +
      denne `onFailedAttempt`, så LangChains AsyncCaller retrier **kun** transiente fejl med eksponentiel
      backoff + jitter (gratis fra AsyncCaller) og kaster resten videre med det samme. Ét sted (`buildModel`)
      dækker default-modellen + alle rolle-modeller.
- [x] **Controller-recovery (core):** nyt injiceret `isTransientError`-seam på `MissionDeps` + `requeueLimit`-governor
      ([controller.ts](../packages/core/src/controller.ts)). `runAndReplan` fanger nu alle kast (kan ikke længere
      crashe den parallelle `Promise.all`-batch): transient/infra → **re-queue** (status `todo`, egen `requeues`-tæller
      adskilt fra thrash `attempts`, `noProgress++` så vedvarende udfald stopper via no-progress, parkeres efter
      `requeueLimit`); ikke-transient → **parkér** for menneske med fejlen logget (`run-error`).
- [x] **Invariant bevaret (robusthed ≠ skjule fejl):** kun transiente fejl retries/re-queues; en ægte logik-/crash-fejl
      overflades (parkeret med fejltekst), aldrig svøbt væk. Kill-switch-abort retries aldrig. Core forbliver ren
      (ingen SDK/fejltyper — predikatet injiceres).
- [x] **Struktureret event-log:** additivt `item_retried`-event (attempt + reason) i `MissionEvent` + render i
      [notifier.ts](../packages/shared/src/notifier.ts). Tokens foldes som hidtil. Wired i
      [mission-worker.ts](../apps/api/src/mission-worker.ts) (`isTransientLlmError` + `requeueLimit` + banner).
- [x] Bevist: [verify-retry.ts](../packages/shared/verify-retry.ts) (28 checks — klassifikation, handler-semantik,
      rigtig AsyncCaller-backoff) + [verify-drift.ts](../packages/core/verify-drift.ts) (15 checks — transient
      genoptager, ikke-transient overflades/parkeres, vedvarende udfald terminerer via requeueLimit OG no-progress,
      bagudkompat). `turbo build` grøn (6/6); alle tidligere harnesses + API-smoke grønne.

### 2026-06-20 — M3 Trin 2: Agent-genererede tests (grøn = stærk sandhed)
- [x] Nyt `TestAuthor`-søm i core ([controller.ts](../packages/core/src/controller.ts)): efter
      implementeren bygger et item forfatter den en test der **udøver** koden i worktree'et **før**
      Verifier kører — så "grøn" betyder *en rigtig test bestod*, ikke bare "det kompilerer". Injiceret,
      **valgfrit** (udeladt ⇒ præcis pre-Trin-2-adfærd), og det springet fra "verificér det der findes"
      til "sørg for at der findes noget der udøver koden".
- [x] LLM-impl `makeTestAuthor` ([testAuthor.ts](../packages/core/src/nodes/testAuthor.ts)): ReAct-loop
      på `createReactAgent` der **genbruger implementerens write-tools** rodfæstet i worktree'et,
      `recursionLimit`-termineret (kan aldrig kile loopet). **Må kun røre test-filer** — er impl'en forkert
      skal testen fejle (det er pointen). Core forbliver ren: den får en **repo-factory** `(worktree) →
      WritableRepoTools` ind (som work-runnerens `buildGraph`), aldrig fs/git.
- [x] **Invariant bevaret:** TestAuthor **rapporterer aldrig pass/fail**; Verifier-exit-koden er stadig
      eneste sandhed for "done" (en test der fejler den buggy kode holder item'et åbent → `applyReplanGuards`).
- [x] Egen konfigurerbar **`tester`-model** (rolle tilføjet til `MODEL_ROLES` i [models.ts](../packages/core/src/models.ts)
      → flyder automatisk gennem `pickModel`/`buildRoleModels`/zod-validering/per-mission-config). Tokens
      foldes ind i mission-budgettet. Gated af `MISSION_AUTHOR_TESTS` (default off); wired i
      [mission-worker.ts](../apps/api/src/mission-worker.ts) med samme worktree-rodfæstede, allowlistede write-tools som implementeren.
- [x] Bevist: [verify-tester.ts](../packages/core/verify-tester.ts) (12 checks, scriptet fake-model + rigtigt
      git-repo) — den forfattede test er **rød** på `a-b` og **grøn** på `a+b`; controlleren kalder sømmet
      **før** verify i det rigtige worktree og folder tokens; springes over uden worktree; bagudkompat uden sømmet.
      `turbo build` grøn (6/6); role-models/mission/decompose-harnesses stadig grønne.

### 2026-06-20 — ★ Team i missioner: kritikeren udfordrer hvert item (grønt-men-forkert fanges)
- [x] `createMissionTeamGraph` ([graph.ts](../packages/core/src/graph.ts)): **implementer → kritiker → revider**,
      bounded af `MISSION_REVIEW_ROUNDS` (default 1; 0 = gammel solo-implementer). Loop-tilbage giver implementeren
      kritikerens issues (`state.verdict.issues`, læses allerede).
- [x] `makeMissionCriticNode` ([missionCritic.ts](../packages/core/src/nodes/missionCritic.ts)): **grounded** review —
      kører `git diff` i worktree'et (i kode via `repo.runCommand`, ikke et LLM-tool → ingen write-lækage) og dømmer
      ændringen mod acceptkriterierne med struktureret verdict (`pass` + `issues`). Egen konfigurerbar **critic-model**.
- [x] **Invariant bevaret:** Verifier (rigtige checks) afgør stadig "done"; kritikeren er en *ekstra* gate, ikke sandheden.
- [x] Wired i [mission-worker.ts](../apps/api/src/mission-worker.ts) (team-graf når review>0, ellers solo-implementer);
      `MISSION_REVIEW_ROUNDS` i env. Per-mission/global team-config'ens critic-valg er nu **aktivt** i missionen.
- [x] Bevist: [verify-mission-team.ts](../packages/core/verify-mission-team.ts) — fail→revider→pass mod et rigtigt
      git-repo (implementeren retter efter kritik) + always-fail terminerer bounded (ingen uendelig loop). `turbo build` grøn (6/6).

### 2026-06-20 — Settings-modal: redigér standard team-modeller (persisteret, runtime)
- [x] Indstillingsknap i railen → modal på 75% af skærmen med menubar (Team-modeller / Providers / Generelt / Om).
      Team-sektionen redigerer den **globale default** team-config; gemt i DB (`app_settings`) så den kan ændres i runtime.
- [x] `AppSettingsService` (shared) + `GET /settings` / `PUT /settings/role-models` (api, validerer provider-nøgler
      server-side). Worker fletter: **mission > global default (DB) > env**. Delt `TeamModelPicker` mellem composer + settings.

### 2026-06-20 — Per-mission team-config (gemt i DB): vælg agent-modeller i mission-opsætningen
- [x] Hver **mission gemmer sit eget team-setup** — hvilken provider/model hver rolle bruger — på
      `missions.role_models` (jsonb). Datatypen er ren config i core ([models.ts](../packages/core/src/models.ts):
      `ModelProvider`/`ModelSpec`/`RoleModelsConfig` + zod), så den flyder gennem core (Mission), DB og API uden SDK.
- [x] **DB**: kolonne `role_models` (idempotent `ALTER … ADD COLUMN IF NOT EXISTS`) + insert/map i
      [BacklogService](../packages/shared/src/backlog.ts); `Mission`/`CreateMissionInput` udvidet.
- [x] **Resolver**: `buildRoleModels(env, mission.roleModels)` ([llm.ts](../packages/shared/src/llm.ts)) —
      missionens valg **fletter over** den globale env-default pr. rolle. Worker'en bygger nu replan/decompose/
      implementer **pr. mission** med dens eget team ([mission-worker.ts](../apps/api/src/mission-worker.ts)).
- [x] **API**: `POST /missions` accepterer `roleModels` ([missions.dto.ts](../apps/api/src/missions/missions.dto.ts));
      servicen afviser en provider hvis dens nøgle mangler server-side ([missions.service.ts](../apps/api/src/missions/missions.service.ts)).
      `roleModels` returneres på mission-objektet (client-wire-typer udvidet).
- [x] **UI**: sammenklappelig "Team-modeller"-sektion i [MissionComposer](../apps/web/app/components/MissionComposer.tsx) —
      pr. mission-rolle (decompose/architect/implementer/critic/lead/replan) et provider-valg (Standard/Mistral/Claude/Gemini)
      + valgfrit model-id. "Standard" arver den globale default.
- [x] Bevist: [shared verify-role-models](../packages/shared/verify-role-models.ts) udvidet med merge-scenarier
      (mission overstyrer env, env-rolle overlever, mission-only-rolle tilføjes, ingen override = ren env). `turbo build` grøn (6/6), API-smoke grøn.

### 2026-06-19 — Per-rolle-modeller: konfigurér hvert team-medlem (fundament for M3 Trin 4)
- [x] Rent core-søm ([models.ts](../packages/core/src/models.ts)): `MODEL_ROLES` + `ModelRole` + `RoleModels`
      + `pickModel(fallback, role, models)`. Hver graf tager nu `model` (fallback) **plus** valgfri
      `models: RoleModels`; en node slår op via `models[role] ?? model`. Springet fra "én model overalt"
      til "vælg model pr. rolle". Rent additivt — udelades `models`, opfører alt sig præcis som før.
- [x] Multi-provider factory i shared ([llm.ts](../packages/shared/src/llm.ts)): `buildModel(env, {provider, model?})`
      dækker **mistral / anthropic (Claude) / google (Gemini)** — ét sted provider-SDK'er instantieres.
      `buildRoleModels(env)` bygger rolle→model-mappen; `getModel(env)` er default/fallback.
- [x] Env-drevet config ([env.ts](../packages/shared/src/env.ts)): `LLM_ROLE_MODELS` (JSON `role→{provider,model?}`),
      `GOOGLE_API_KEY`, og `LLM_PROVIDER` udvidet med `google`. Zod afviser **ukendte roller** (typo) og kræver
      **API-nøgle for hver brugt provider** (fx en google-rolle kræver `GOOGLE_API_KEY`).
- [x] Wired overalt: team/project/agent/repo-graferne (via ny `ROLE_MODELS`-DI-token i [app.module.ts](../apps/api/src/app.module.ts)
      + [runs.service.ts](../apps/api/src/runs/runs.service.ts)), missions-stien (implementer/replan/decompose via
      `pickModel` i [mission-worker.ts](../apps/api/src/mission-worker.ts)) og CLI'en. `@langchain/google-genai@2.1.26` tilføjet.
- [x] Bevist: [verify-role-models.ts](../packages/core/verify-role-models.ts) (core: resolution + grafer kompilerer
      med/uden map) + [verify-role-models.ts](../packages/shared/verify-role-models.ts) (shared: critic→Gemini,
      implementer→Claude, architect→Mistral, fallback, ukendt rolle + manglende nøgle afvist). Fuld `turbo build` grøn (6/6),
      API-smoke grøn. Beskrevet i design-brief §3.8.
- [x] Sidegevinst: human-gaten persisterer nu **reviewer-noter ved godkendelse** i transcriptet
      ([humanGate.ts](../packages/core/src/nodes/humanGate.ts)) — opfylder en stående (rød) smoke-assertion.
- [ ] **Rest af M3 Trin 4:** prompt-caching på stabile system-prompts; per-rolle temperatur; UI til at vælge
      team-medlemmers modeller pr. projekt/mission (i dag env-drevet).

### 2026-06-18 — M3 Trin 1: Decomposer (missionen planlægger sin egen backlog)
- [x] `Decomposer`-søm i core ([controller.ts](../packages/core/src/controller.ts)) — injiceret som
      `Replanner`/`Verifier`/`Integrator`; `DecomposeInput`/`DecomposeResult`/`DecomposedItem`. Springet
      fra "mennesket skriver item-listen i UI'et" til "giv motoren et mål, den planlægger selv".
- [x] LLM-impl `makeDecomposer` ([decompose.ts](../packages/core/src/nodes/decompose.ts)): mål +
      acceptkriterier → små, uafhængigt-verificerbare items med prioritet, `dependsOn` (pr. `key`) og `risk`.
- [x] **Kaldt kun på en tom backlog** i [runMission](../packages/core/src/controller.ts) (efter resume-hygiejne,
      før loopet) → en hand-seedet mission beholder sine items, og et resume re-dekomponerer **aldrig**.
- [x] `createDecomposedItems`: to-pass key→id-resolution (vilkårlig DAG uden topo-sort); ukendte keys og
      selv-deps droppes defensivt → en model-slip kan ikke kile loopet. `applyDecomposeGuards` capper antal
      (default 40), gør keys unikke, dropper tomme titler, stripper deps til ukendte keys.
- [x] Decompose-tokens foldes ind i mission-budgettet. Wired i mission-worker (`makeDecomposer(model)` → deps).
- [x] Bevist: [verify-decompose.ts](../packages/core/verify-decompose.ts) (19 checks, fakes — key-resolution,
      idempotens, guards, end-to-end via runMission, bagudkompat) + [verify-decompose-live.ts](../packages/core/verify-decompose-live.ts)
      (live Mistral planlagde en 8-punkts todo-API-backlog med korrekt afhængigheds-DAG + validerings-items). `turbo build` grøn (6/6).

### 2026-06-18 — M2 Trin 6: Parallelisme (M2 i mål 🎉)
- [x] `concurrency`-governor i controlleren ([packages/core/src/controller.ts](../packages/core/src/controller.ts)):
      picker en **batch** på op til N actionable items, kører dem **parallelt** (`Promise.all`: eksekvering +
      worktree-verifikation hver i sit worktree), men **finaliserer/integrerer sekventielt** — merge + re-verify
      på den delte mission-branch må ikke race. Default 1 = nøjagtig den serielle loop (bagudkompat).
- [x] Loop-kroppen refaktoreret til `pickBatch` / `runAndReplan` (parallel) / `finalize` (seriel); alle governors,
      thrash-guard, resume og kill switch bevaret uændret.
- [x] **Afhængigheder holder under concurrency:** en in_progress-markeret parent gør sin dependent
      ikke-actionable → dependent kan ikke havne i samme batch. `MISSION_CONCURRENCY` i env + worker.
- [x] Worktree-manageren serialiserer git-mutationer internt (index.lock-mutex) så samtidige `git worktree add`
      ikke racer; det tunge arbejde forbliver parallelt.
- [x] Bevist ([verify-mission.ts](../packages/core/verify-mission.ts): 3 items samtidigt, merges forblev serielle,
      afhængigheder holdt + alle tidligere scenarier grønne; [verify-worktree.ts](../packages/shared/verify-worktree.ts):
      5 samtidige creates/removes uden race). `turbo build` grøn (6/6).

### 2026-06-18 — M2 Trin 5: Integration + verificér-efter-merge (mission-branchen altid grøn)
- [x] `Integrator`-seam i core ([packages/core/src/controller.ts](../packages/core/src/controller.ts)):
      `merge`/`rollback`/`cleanup` — pure git, injiceret som de øvrige sømme. Controlleren orkestrerer
      merge → re-verify (via Verifier, ét sandhedssted) → rollback/cleanup.
- [x] **Done kræver grøn EFTER merge:** grønt worktree → commit på item-branch → merge til mission-branch →
      `Verifier.run(checks)` på mission-branchen. Grøn ⇒ done + cleanup; merge-konflikt ⇒ park;
      rød post-merge ⇒ **rollback** + park. To uafhængigt grønne items kan summe til rød — det fanges nu.
- [x] `createGitIntegrator` + `ensureGitBranch` i shared ([packages/shared/src/integrator.ts](../packages/shared/src/integrator.ts)):
      committer implementerens ucommittede worktree-ændringer på item-branchen (ellers var merge no-op),
      `merge --no-ff` m. abort på konflikt, `reset --hard` rollback, worktree-cleanup. Git-helpere udtrukket til delt [git.ts](../packages/shared/src/git.ts).
- [x] Branch-topologi: mission-branch `mission/<id>/integration`, items `mission/<id>/item/<x>` — begge under
      `mission/<id>/` så ingen git ref D/F-konflikt. Worktree-roden ekskluderes fra `git status` via `.git/info/exclude`.
- [x] **Mission-worker wired:** ensure mission-branch → item-branches baseres på den → integrator pr. mission.
- [x] Bevist: git-integrator ([verify-integrator.ts](../packages/shared/verify-integrator.ts), 13 checks, rigtig git:
      merge/konflikt-abort/rollback/cleanup) + controller-orkestrering ([verify-mission.ts](../packages/core/verify-mission.ts),
      udvidet: done-efter-merge, konflikt→park, rød-post-merge→rollback+park, bagudkompat uden integrator). `turbo build` grøn (6/6).

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
- [x] **Opdatér README/docs.** *(leveret 2026-06-23)* [README.md](../README.md) skrevet om: Opgave/Mission-modes,
      hele team-rosteren, missions-motoren (M1–M3), web-appen, projekter/hukommelse, per-rolle/per-projekt/per-mission
      modeller, fuld API-rute-tabel, setup (docker compose Postgres) + run (web/worker/CLI), verify-harnesses og PM2.
- [ ] **Slet/omdøb projekt fra UI.** Backend har `DELETE /projects/:id` + `PATCH`,
      men der er ingen knap i web-appen endnu.
- [ ] **Rediger projekt-brief/navn i UI.** I dag kun ved oprettelse.
- [x] **Kerne-tests.** *(leveret 2026-06-23)* De tre flaggede huller er dækket hermetisk i
      [verify-graph-nodes.ts](../packages/core/verify-graph-nodes.ts) (25 checks, fake-model + fake-memory):
      critic'ens **deterministiske rubric pass-regel** (alle required mødt + score ≥ threshold, kan ikke passes ved
      udeladelse, optional blokerer ikke), **router-valg** (single/team-mapping + token-fold), og **memory-noderne**
      (retrieve pakker brief+hits → context; persist skriver artifact, best-effort). `memory store/retrieve` mod rigtig
      pgvector er allerede dækket live i [verify-memory.ts](../packages/shared/verify-memory.ts). Resten af motoren har
      20+ `verify-*`-harnesses; et egentligt test-framework er stadig fravalgt til fordel for disse.
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
- [x] **5. Integration + verificér-efter-merge** — `Integrator`-seam (`merge`/`rollback`/`cleanup`),
      git-impl `createGitIntegrator`. Controller: grønt worktree → merge til mission-branch →
      **re-verify på mission-branch** → done **kun** hvis grøn efter merge; konflikt el. rød post-merge
      (rulles tilbage) → park `blocked_needs_human`. Mission-branchen forbliver altid grøn. (`controller.ts` + `integrator.ts`)
- [x] **6. Parallelisme** — `concurrency`-governor (default 1 = seriel): N items kører **parallelt**
      (hver i egen worktree, eksekvering + worktree-verifikation samtidigt), men **integration er seriel**
      (merge + re-verify på den delte mission-branch må ikke race). Afhængigheder holder (en dependent
      kan ikke i samme batch som sin parent). Worktree-manageren serialiserer git-mutationer (index.lock-mutex). (`controller.ts`)

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

Mål: hæve missionen fra "kan forfatte kode" (M2) til **kan stoles på natten over**.
Fire temaer: (1) **dybere verifikation** — agent-genererede tests, så "grøn build" er
en stærk sandhed, ikke kun lint/build; (2) **konvergens-kvalitet** — bedre
dekomponering, undgå thrash, vide hvornår "godt nok"; (3) **drift over mange timer** —
cost/budget i skala, model-valg, caching, rate-limit-retries, fejl-recovery;
(4) **tillids-UX** — diffs man kan godkende/afvise, morgendigest, kurskorrektion undervejs.

> **Forudsætning bevist (2026-06-18):** M2-kæden kører end-to-end med en *live* model —
> [smoke-mission.ts](../packages/core/smoke-mission.ts) lod Mistral forfatte rigtig kode der
> blev grøn på mission-branchen (1 item, 1 iteration). M3 er springet fra den trivielle
> røgtest til **flerlags-opgaver man tør lade køre uovervåget.**

Build-order (shippet + bevist pr. trin, som M1/M2). Foundation → tillid:

- [x] **1. Decomposer (mål → backlog).** *(leveret 2026-06-18)* Nyt `Decomposer`-søm i core
      ([controller.ts](../packages/core/src/controller.ts)) + LLM-impl `makeDecomposer`
      ([decompose.ts](../packages/core/src/nodes/decompose.ts)) der oversætter mål +
      acceptkriterier → prioriterede items med `dependsOn` + `risk`. Kaldt ved mission-start
      **kun når backloggen er tom** (idempotent → resume/hand-seed re-dekomponerer ikke).
      Afhængigheder udtrykkes pr. `key` og resolves til rigtige ids (`createDecomposedItems`,
      to-pass, dropper ukendte/selv-deps). Guards capper antal, gør keys unikke, dropper tomme
      titler. Wired i mission-worker. *Bevist:* [verify-decompose.ts](../packages/core/verify-decompose.ts)
      (19 checks, fakes) + [verify-decompose-live.ts](../packages/core/verify-decompose-live.ts)
      (live Mistral → 8-punkts plan med korrekt afhængigheds-DAG). `turbo build` grøn (6/6).
- [x] **★ Team i missions-eksekvering (det største spring mod visionen)** *(leveret 2026-06-20).*
      Hvert mission-item kører nu `createMissionTeamGraph`: **implementer → kritiker → revider**, bounded af
      `MISSION_REVIEW_ROUNDS` (default 1). Kritikeren ([missionCritic.ts](../packages/core/src/nodes/missionCritic.ts))
      udfordrer den **rigtige `git diff`** (fanget i kode, ikke via et LLM-tool → ingen write-evne lækker) mod
      acceptkriterierne og looper tilbage med konkrete issues ved fail — fanger **grønt-men-forkert**. Kritikeren
      bruger sin **egen konfigurerede model** (fx billig Gemini over Claude-implementer). Verifier (rigtige checks)
      afgør stadig "done"; review er en ekstra gate. *Bevist:* [verify-mission-team.ts](../packages/core/verify-mission-team.ts)
      (fail→revider→pass mod rigtigt git-repo + always-fail terminerer bounded). `turbo build` grøn (6/6).
- [x] **2. Agent-genererede tests (grøn = stærk sandhed).** *(leveret 2026-06-20)* Nyt
      `TestAuthor`-søm i core ([controller.ts](../packages/core/src/controller.ts)) + LLM-impl
      `makeTestAuthor` ([testAuthor.ts](../packages/core/src/nodes/testAuthor.ts)): efter
      implementeren (og kritikeren) forfatter den en test der **udøver** ændringen i
      worktree'et — **før** Verifier kører — så samme check der afgør "done" også kører den
      nye test. ReAct-loop der genbruger implementerens write-tools, `recursionLimit`-termineret,
      og **må kun røre test-filer** (ikke impl: en forkert impl skal få testen til at fejle).
      Den **rapporterer aldrig pass/fail** — Verifier-exit-koden er stadig eneste sandhed. Egen
      konfigurerbar **`tester`-model** (rolle tilføjet til `MODEL_ROLES`). Gated af
      `MISSION_AUTHOR_TESTS` (default off ⇒ uændret), wired i mission-worker. *Bevist:*
      [verify-tester.ts](../packages/core/verify-tester.ts) (12 checks) — en forfattet test er
      **rød** på en buggy impl og **grøn** når den rettes; controlleren kalder sømmet før verify
      i det rigtige worktree + folder tokens; springes over uden worktree; bagudkompat uden sømmet.
      `turbo build` grøn (6/6).
- [x] **3. Drift-robusthed (overlever natten).** *(leveret 2026-06-20)* To lag holder en lang
      kørsel i live gennem transiente blips uden at skjule rigtige fejl. **(1) LLM-retry** (shared):
      `buildModel` bygger hver model med env-drevet `MISSION_LLM_MAX_RETRIES` + en `onFailedAttempt`
      (`isTransientLlmError`, [retry.ts](../packages/shared/src/retry.ts)) så providerens AsyncCaller
      retrier **kun** transiente fejl (429/5xx/timeout/netværk) med eksponentiel backoff + jitter, og
      kaster 4xx/auth/quota/kill-switch-abort videre med det samme. **(2) Controller-recovery** (core):
      et injiceret `isTransientError`-seam (core forbliver SDK-fri) lader `runMission` fange et kast —
      transient/infra **re-queues** item'et (egen tæller adskilt fra thrash, bounded af
      `MISSION_REQUEUE_LIMIT`, tæller som no-progress så en vedvarende udfald stadig stopper missionen);
      en ikke-transient fejl **parkeres** for et menneske med fejlen logget — fanget, aldrig svøbt væk,
      og aldrig crasher den parallelle batch. Nyt `item_retried`-event (struktureret retry-log).
      *Bevist:* [verify-retry.ts](../packages/shared/verify-retry.ts) (klassifikator + rigtig
      AsyncCaller-backoff, 28 checks) + [verify-drift.ts](../packages/core/verify-drift.ts)
      (transient genoptager; ikke-transient overflades; vedvarende udfald terminerer, 15 checks).
      `turbo build` grøn (6/6).
- [x] **4. Per-rolle modeller + prompt-caching (cost/kvalitet).** *(i mål 2026-06-23)*
  - [x] **Per-rolle modeller (global)** *(leveret 2026-06-19)* — `MODEL_ROLES`/`pickModel`-søm i core +
        `buildRoleModels(env)` i shared (mistral/anthropic/google), env `LLM_ROLE_MODELS`. Wired i alle
        grafer + missions-stien + CLI. Bevist. Se "Senest leveret" + design-brief §3.8.
  - [x] **Per-mission team-config + UI** *(leveret 2026-06-20)* — gemt på `missions.role_models`, valgt i
        MissionComposeren; `buildRoleModels(env, mission.roleModels)` fletter pr. mission over default.
  - [x] **Prompt-caching** på de stabile system-prompts (Anthropic) *(leveret 2026-06-23)* —
        `CachingChatAnthropic` i [llm.ts](../packages/shared/src/llm.ts) defaulter en top-level ephemeral
        cache-breakpoint på hvert Claude-kald (gated af `LLM_PROMPT_CACHE`, default on). Det store spar er
        implementer/tester-ReAct-loopet: tools + system + den voksende transcript læses fra cache (~0.1x) hver
        tool-runde. *Bevist:* [verify-prompt-cache.ts](../packages/shared/verify-prompt-cache.ts) (wiring, ingen nøgle)
        + [verify-prompt-cache-live.ts](../packages/shared/verify-prompt-cache-live.ts) (måler cache_read>0 på 2. kald).
  - [x] **Per-rolle temperatur** (fx critic=0) *(leveret 2026-06-23)* — `temperature?` på `ModelSpec`
        ([models.ts](../packages/core/src/models.ts)) flyder gratis gennem env/per-mission/settings (alle bruger
        `RoleModelsConfigSchema`); [buildModel](../packages/shared/src/llm.ts) honorerer den pr. provider og
        **dropper den for adaptive-only Claude** (Opus 4.7/4.8, Fable) der 400'er på temperatur — fixer samtidig
        en latent bug (hardkodet `0.2` ville have crashet en Opus-4.8-rolle). UI-input pr. rolle i `TeamModelPicker`.
        *Bevist:* [verify-role-models.ts](../packages/shared/verify-role-models.ts) udvidet (critic=0 flyder, default
        0.2, Sonnet beholder, Opus 4.8 dropper + invocationParams kaster ikke).
  - [x] **Per-projekt default + redigér en kørende missions team** *(leveret 2026-06-23)* — projektet gemmer sit eget
        standard-team (`projects.settings.roleModels`); en ny mission arver det ved oprettelse (`mergeRoleModels`), og
        `PATCH /missions/:id/role-models` re-pointer en kørende missions team (træder i kraft næste pass). Netto-præcedens:
        **mission > projekt > global > env** — uden at røre workeren. Se "Senest leveret".
- [x] **5. Approvable diffs (se hvad motoren skrev).** *(leveret 2026-06-23)* `Differ`-søm: pr. item en
      struktureret diff (ændrede filer, ±linjer, patch) — fanget på item'ets worktree før verify/merge,
      persisteret på item'et, og vist på dashboardet (især parkerede items, så et menneske kan **se** ændringen
      før Godkend/Afvis). Se "Senest leveret". *Rest:* lazy-load patchen pr. item så SSE-frames forbliver små.
- [x] **6. Morgendigest + kurskorrektion.** *(leveret 2026-06-23 — M3 i mål 🎉)* Rigere digest
      (hvad der blokerer + hvorfor, næste høj-risiko-items, seneste aktivitet) leveret via `Notifier`
      (`mission_digest`-event, også på menneske-Stop) + et `guidance`-felt: et menneske sender fri-tekst
      til en *kørende* mission, der flyder ind i næste replan/decompose-prompt (kurskorrektion ud over Stop).
      Se "Senest leveret".

Invarianter (bevares fra M1/M2):

- **Verifier er stadig sandheden for "done"** — også for genererede tests (Trin 2): de er
  rigtige checks med rigtig exit-kode, ikke en LLM-score. Et item kan aldrig blive "done" på
  en rød build (`applyReplanGuards`).
- **Core forbliver ren:** `Decomposer`/`Differ` injiceres som de øvrige søm; ingen `Date.now()`,
  ingen transport/framework-deps. Retries/backoff lever i shared/worker, ikke i pure core.
- **Robusthed ≠ skjule fejl:** kun *transiente* fejl retries; en ægte logik-/build-fejl skal
  stadig parkeres/feedes ind i næste replan, ikke svøbes væk (Trin 3).
- **Mennesket overvåger asynkront:** kurskorrektion (Trin 6) blokerer aldrig loopet — guidance
  konsumeres ved næste checkpoint, ligesom park-beslutninger.

### Øvrige temaer (M4 — produktisering)

- [ ] **Løft `@arzonic/agent-core` ind i Ranky/Bravy** (eller publicér pakken) — "run once,
      serve everywhere" via `@arzonic/agent-client`.
- [ ] **Multi-tenant / brugere & roller** hvis appen skal ud over én intern bruger.
- [ ] **Observability**: strukturerede logs, kørsels-metrics, LangSmith-traces linket fra UI.
- [ ] **Deploy af web-appen** (i dag kun api via PM2): byg og host Next-appen + miljø-secrets.
