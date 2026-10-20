# Content Agents — Plan (rev 3.1, 2026-10-19)

Goal: a small, loop-driven system that turns (a) what the people I read are saying,
(b) what I'm actually building at work, and (c) how my own posts perform into a steady
stream of LinkedIn + Hashnode ideas and drafts in my voice. **I write and publish myself;
the system feeds me, learns from what I pick, and goes looking for new sources on its own.**
Budget: under $10–20/month. Code is public; my state is private.

Brand reference: Alex Lindahl, "5 strategic ways to build your GTME brand"
(newsletter.gtmengineering.ai): keep a swipe file of hooks with a *generic reusable
version* and a why-it-worked hypothesis; publish builds as proof; results over launches;
personality over polish; "screenshot + one line" over-performs.

Design references: LangChain, "The Art of Loop Engineering" (four stacked loops: agent →
verification → event-driven → hill-climbing, humans at every level); Lilian Weng,
"Harness Engineering for Self-Improvement" (filesystem as memory, evaluator and
permissions *outside* the self-editing loop, guard against diversity collapse, preserve
negative results).

---

## 1. Decisions

| # | Decision |
|---|---|
| 1 | **Sources are a registry, not a list.** Every source and search term is a record with a lifecycle (`candidate → trial → active → paused → retired`), provenance, and a yield score. Nothing is hardcoded; my seeds are one input among several. The agent discovers and proposes new ones (§4). |
| 2 | **Brain scope:** `projects/` + `daily/` primary, `knowledge_base/` + `sessions/` secondary, `environments/` + customer/people files excluded. Brain ingest daily; ideation twice a week. |
| 3 | **Runs on Trigger.dev** (free: $5/mo compute, 10 schedules, ≥1 hr cadence, webhooks). TypeScript: Trigger.dev SDK + LangGraph.js + LangSmith JS. Side trials: LangSmith Fleet for the retro agent; Trigger.dev `chat.agent` for "talk to my swipe file." |
| 4 | **No automated publishing.** Hashnode API is Pro-only since 2026-05-13 and I want to write myself. Outcome measurement is LinkedIn-only (Apify on my own profile). |
| 5 | **Voice from Hashnode RSS**, pulled once; approved drafts extend it. |
| 6 | **Slack: my personal workspace** , a bot app `content-agents` (manifest in `slack-app/`, managed with the Slack CLI) posting to `#content-agents`. Fully separate from the work-notes repo. |
| 7 | **`rewrite` verdicts re-run immediately.** Trigger.dev's inbound webhooks are private beta (requested), so until then: a GitHub Action on the state repo calls the Trigger.dev API on push (`feedback-webhook`), and a ~40-line Cloudflare Worker relays Slack events for intake. Both free. The hourly sweep stays as the safety net. |
| 8 | **Manual intake is a first-class input.** A post link (with an optional note) dropped in a Slack channel or `queue/saved/` is fetched, distilled, credited to its author as the strongest possible signal, and riffed on immediately (§5b). A publication/profile link becomes a candidate source with an immediate trial. |
| 9 | **Two repos.** `content-agents` (public: code, prompts, schemas, example config, docs) and a private state repo (my sources, terms, redact list, queue, data, memory). Tasks clone both; repo names come from env vars. |

---

## 2. Research (settled)

| Question | Answer | Cost |
|---|---|---|
| Substack | Public API, no Apify: `/api/v1/posts?limit&offset` (title, `body_html`, `reactions`, `comment_count`, `restacks`, `wordcount`, `postTags`); `/api/v1/archive?sort=top&limit=N` gives a publication's **top posts** — perfect for a cheap trial pull on a candidate. Cross-publication links in `body_html` and `/recommendations` pages give **discovery for free**. Publication search endpoint returns empty unauthenticated. Fallback for blocked custom domains: RSS → `parsebird/substack-scraper` $0.39/1k. | $0 |
| LinkedIn creators | `harvestapi/linkedin-profile-posts`: no cookies, $1.50–2/1k, text + likes/comments/shares + reaction breakdown + mentions/reposted authors + comment authors. `postedLimit`, `maxPosts`. A 5-post trial pull on a candidate costs ~$0.01. | ~$2–3/mo |
| My LinkedIn performance | No personal API without LinkedIn approval; same actor on my profile weekly. | ~$0 |
| LinkedIn keyword search | Cookie-based actors only ($0.50/1k, needs my session). **Rejected**: account risk. Discovery comes from the graph instead (§4). | — |
| Apify | Free: $5 credit/mo, blocks rather than bills. | $0 |
| X | `apidojo/tweet-scraper` $0.40/1k; search terms are a first-class input here. Phase 4. | $0–1 |
| LangSmith | Developer: free, 5k traces/mo, 14-day retention, datasets/evals/feedback, 1 Fleet agent / 50 runs/mo. | $0 |
| Hashnode | API Pro-only (May 2026). RSS public but Cloudflare-gated for bare curl; fetch from the runner or browser once. | $0 |
| Trigger.dev | Free: $5 credit, 20 concurrent, 10 schedules/project, schedules ≥ hourly, webhook triggers, Python via `pythonExtension`. Small-1x ≈ $0.0000338/s → 10-min run ≈ $0.02. Billing limit = plan max. | $0 |
| LLM | Anthropic API: Haiku 5.5 for extraction/scoring/redaction checks, Sonnet 5.5 for ideation/drafting/retro. | ~$3–8/mo |

**Projected total: ~$5–10/month.**

---

## 3. Source & term registry (the foundation)

Two files in the private state repo, both validated against zod schemas that live in the
public repo (`schemas/source.ts`, `schemas/term.ts`). The public repo ships
`config/sources.example.yaml` with a handful of entries so anyone can fork it.

```yaml
# sources.yaml — one record per source
- id: substack:nabeelqu
  type: substack            # substack | linkedin | x | rss | hashnode | youtube (future)
  url: https://nabeelqu.substack.com
  author: Nabeel S. Qureshi
  status: active            # candidate | trial | active | paused | retired
  tags: [thinking, writing]
  added_by: human           # human | agent:<task>:<run_id>
  added_at: 2026-10-19
  discovered_via: seed      # seed | link:<item_id> | mention:<item_id> | recommendation:<source_id>
                            # | comment:<item_id> | term:<term_id> | roundup:<item_id>
  method: substack_api      # resolver fills: substack_api | rss | apify:<actor>
  pheromone:                # yield, maintained by the system (§4)
    hits: 3                 # items that cleared the hook threshold or were cited by an approved card
    misses: 9               # items pulled that did neither
    last_hit_at: 2026-10-12
    decayed_at: 2026-10-17  # last evaporation
  budget_tier: normal       # cheap | normal | expensive  (substack=cheap, linkedin=normal, x=normal)
  notes: ""                 # free text; the retro appends one-liners
```

```yaml
# terms.yaml — keywords / search terms, same lifecycle + pheromone
- id: term:gtm-engineer
  term: "gtm engineer"
  kind: topic               # topic | hashtag | x_query | person_query
  status: active
  used_for: [tagging, x_search, candidate_relevance]
  added_by: human
  discovered_via: seed
  pheromone: {hits: 0, misses: 0}
```

Operations (public repo CLI, also callable by tasks):
- `ca sources add <url|@handle> [--tags ...]` → detects type, resolves method, writes a
  `candidate` (or `active` with `--active`). Dupes by normalized URL.
- `ca sources ls --status active --type linkedin`, `ca sources set <id> status=paused`.
- `ca terms add "<term>" --kind topic`.
- `ca sources import <file>` for bulk (how my 74 Substacks and the LinkedIn seed go in).
- Every mutation is a commit to the state repo, so provenance is `git log`.

---

## 4. Foraging: how the system finds new sources (the ants)

Ants don't all follow the best trail; most do, some wander, and trails that stop paying
evaporate. Mapping:

| Ant colony | Here |
|---|---|
| Pheromone on a trail | `pheromone.hits / misses` per source and term |
| Evaporation | Weekly decay: `hits *= 0.85`, `misses *= 0.85` (half-life ≈ 4 weeks) |
| Following strong trails | Each ingest run allocates most of its item budget to sources sampled by **Thompson sampling** on `Beta(1 + hits, 1 + misses)` — high-yield sources get pulled more, but stochastically, never deterministically |
| Random wandering | An exploration share `ε` (default 0.2) of the budget goes to `candidate`/`trial` sources; one slot per run is a **uniform random** candidate regardless of prior, so nothing is unreachable |
| Finding food | A pulled item clears the hook threshold (distill `engagement_z ≥ 1` or hook quality ≥ 4/5) → `hit` on its source and on the terms it matched; an approved card citing it → +2 hits |
| Laying new trails | **Candidate generation** (below) |
| Colony size limit | Caps in `config/foraging.yaml`: max active per type, max auto-promotions/week, monthly $ per type |

**Candidate generation** (deterministic, runs inside `ingest-distill`, $0):
- Substack: outbound links to other publications in `body_html` of items with `engagement_z ≥ 1`
  (verified: Nabeel's last 12 posts link 2 other pubs); `/recommendations` pages of active
  Substacks; authors of roundup posts ("10 newsletters I read").
- LinkedIn: authors mentioned/tagged or reposted in high-z posts; commenters whose comment
  has ≥ N reactions on high-z posts (already in the HarvestAPI output).
- Terms: topics that appear in ≥ 3 top hooks this week but match no active term → candidate term.
- Phase 4: X search on active `x_query` terms; web search (Exa/Firecrawl free credits) on
  `person_query` terms like "gtm engineer newsletter".
- Me: anything I save to `queue/saved/` (a URL in a markdown file) becomes a candidate with
  `discovered_via: human`.

**Trial** (cheap, bounded): a candidate selected for exploration gets a trial pull —
Substack `archive?sort=top&limit=5` ($0), LinkedIn `maxPosts: 5` (~$0.01). Distill scores
the 5 items for hook quality and relevance to active terms. Pass → `trial` with pheromone
seeded from the trial; fail → `misses += 5`, stays `candidate`, and is simply less likely
to be sampled again (not banned).

**Promotion / demotion** (the only part that touches `status`):
- `trial → active`: ≥ 3 hits in 3 weeks. Auto if under the weekly cap; otherwise proposed
  in the Friday retro Slack DM for me to approve by commit.
- `active → paused`: pheromone hits < 0.5 after decay for 8 weeks. Proposed, not automatic.
- `paused → retired`: 12 more weeks untouched. Retired sources keep their record (negative
  results are data; Weng's point).

**Diversity guard:** no topic cluster may exceed 40% of active sources; if it does, the
exploration share for that cluster drops to zero until it's under. `ε` has a floor of 0.1.

**What the agent never does:** edit `config/foraging.yaml` (thresholds, caps, ε, decay),
edit live prompts, or spend beyond `budget.yaml`. Those are the evaluator and permission
layers, kept outside the self-improving loop. The retro can *propose* changes to any of them.

---

## 5. The loop

```
 SOURCES (registry, §3)                TRIGGER.DEV (free)                                    ME
 ────────────────────────────          ────────────────────────────────────────────          ───────────────
 Substack API      daily  ──►  ingest (Thompson-sampled) ──► distill (Haiku) ──┐
 the work-notes repo      daily  ──►  ingest + redact                                 ├─► ideate (Sonnet) ─► queue/inbox/*.md ─► verdict 👍👎✍️
 LinkedIn (Apify)  weekly ──►  ingest + candidates                             │     Sun + Wed                                 │ commit
 my LinkedIn       weekly ──►  measure ───────────────────────────────────────►┘                                               ▼
                                   ▲                                              draft (Sonnet) ◄── feedback ◄── GitHub push webhook
                                   │                                                  │           (LangSmith scores; rewrite → ideate-one now)
                             I publish by hand,                                       ▼
                             paste URL into card ◄─────────────────────────── queue/drafted/

 retro (Fri, Sonnet) ──► memory/*.md · prompts/proposed-changes.md · source promotions/demotions · Slack DM
```

| Stage | When | Model | What |
|---|---|---|---|
| **ingest** | daily 05:00 ET | none | Thompson-sample sources within `budget.yaml`; pull new items → `data/items/<type>/<yyyy-mm>.jsonl`; brain ingest + redaction (§6); generate candidates (§4). |
| **distill** | same run | Haiku | Per external item: `hook`, `hook_template`, `format`, `topics[]`, `engagement_z` (per author), `why_it_worked`, `hook_quality 1–5`. Per brain item: `build`, `decision`, `gotcha`, `shareable`. Updates pheromone. |
| **ideate** | Sun + Wed 06:00 | Sonnet | Inputs are queries (DuckDB over jsonl): top-k hooks, trending topics, brain items from the last 3–4 days, my last 20 posts + outcomes, `memory/*`. Output 6–8 cards → `queue/inbox/`, Slack DM with hooks inline. |
| **verdict** | me | — | `verdict: approve \| reject \| rewrite`, optional `why:`. Commit from anywhere. |
| **intake** | on Slack message or push to `queue/saved/` | Haiku + Sonnet | See §5b. Post link → item + swipe-file record (`saved_by: human`, `note`) + author source boost + 1–2 riff cards. Source link → candidate + immediate trial. |
| **feedback** | on push (webhook) + hourly sweep | none / Sonnet | Score → LangSmith run; `data/feedback.jsonl`; move card. `approve` → draft now. `rewrite` → `ideate-one` now with my note. Pheromone +2 on cited sources. |
| **draft** | on approve | Sonnet | LinkedIn ≤1300 chars hook-first; Hashnode outline + sections. Voice from `memory/voice.md`. → `queue/drafted/`. |
| **publish** | me | — | By hand. URL into `published_url`. |
| **measure** | Mon 05:30 | none | Apify on my profile: 48h/7d likes/comments/shares onto the card + `data/published.jsonl`. |
| **retro** | Fri 16:00 | Sonnet | Verdicts + outcomes → `memory/winning-patterns.md`, `rejected.md`, `topics-covered.md`; refresh ideate few-shots; `prompts/proposed-changes.md`; source/term promotions, demotions, new-candidate digest; LLM-judge vs my verdicts; Slack DM. |

**Loop mapping (LangChain's four):** Loop 1 = each stage's agent. Loop 2 = the judge on
drafts + my verdict as the human grader. Loop 3 = Trigger.dev schedules + the GitHub
webhook. Loop 4 = retro + foraging (hill-climb on prompts, memory, *and* the source set),
with every change to prompts/thresholds going through my review by commit.

Schedules: 6 of 10 free slots (`ingest-distill`, `ideate`, `measure`, `retro`,
`ingest-linkedin` Sun 04:00, `feedback-sweep` hourly) + 2 webhook tasks (GitHub push, Slack intake).

### 5b. Manual intake: "here, look at this"

Two doors, one pipeline:
- **Slack:** a dedicated channel in my personal workspace. I post a link, optionally with a
  sentence of why. A minimal Slack app forwards channel messages to a Trigger.dev webhook
  (`intake-webhook`). Free.
- **File:** a markdown file with the URL + note in `queue/saved/` in the state repo. The
  existing GitHub push webhook routes it to the same task.

What `intake` does with a **post** link:
1. Classify: substack post / linkedin post / x post / generic article.
2. Fetch: Substack `/api/v1/posts/<slug>` ($0); LinkedIn post URL via HarvestAPI (~$0.002);
   X via apidojo; generic → scrape to markdown.
3. Distill into the swipe file with `saved_by: human`, `note`, `saved_at`.
4. Pheromone: `+3` hits on the author's source (created as `candidate` if new) and on matched
   terms — a manual save outranks any automatic hit. A new author gets a trial pull now, not
   whenever sampling reaches them.
5. Riff: `ideate-one` produces 1–2 cards connecting the post to my recent builds, steered by
   my note. Cards carry `seed: saved:<item_id>` so the retro can separate "ideas I asked for"
   from "ideas it found."

What it does with a **publication/profile** link: steps 1, 4 (as candidate) and an immediate
trial. No riff.

Phase 4: screenshots posted to the same channel → vision model extracts text → same path.
That's the screenshot-commentary format.

---

## 6. Mining the work-notes repo safely

- **In:** `projects/*.md`, `projects/*.log.md`, `daily/*.md` → `## Capture` only,
  `knowledge_base/*.md`, `sessions/**/*.md` → `## Discoveries` + `## Roadblocks`,
  `lists/leadership-ideas.md` `[me]` items.
- **Out:** `environments/**`, `daily/*.md` → `## Calls`, `enriched/`, `knowledge/deals.md`,
  `knowledge/people.md`, `lists/people-to-meet.md`, anything matching `redact.yaml`.
- Redaction two-pass: deny-list substitution (`[customer]`, `[id]`, `[link]`), then a Haiku
  check that flags anything still reading as a specific deal or person → dropped, not fixed.
- Brain-derived items live **only in the private state repo**. Ideas are framed as patterns
  and builds, never deals. Read with a fine-grained GitHub token, read-only on the work-notes repo.

---

## 7. Repos

**`content-agents` (public)**
```
├── README.md  PLAN.md  LICENSE
├── trigger.config.ts  package.json
├── src/
│   ├── trigger/      ingest-distill.ts ideate.ts feedback-webhook.ts feedback-sweep.ts
│   │                 intake-webhook.ts draft.ts measure.ts retro.ts ingest-linkedin.ts
│   ├── registry/     sources.ts terms.ts resolve.ts thompson.ts pheromone.ts candidates.ts
│   ├── ingest/       substack.ts linkedin.ts brain.ts redact.ts hashnode-rss.ts fetch-one.ts
│   ├── agents/       distill.ts ideate.ts draft.ts retro.ts        # LangGraph.js, traced
│   ├── lib/          state-repo.ts duckdb.ts slack.ts apify.ts cards.ts budget.ts
│   └── cli.ts        # `ca sources|terms ...`
├── schemas/          source.ts term.ts card.ts item.ts foraging.ts budget.ts
├── prompts/          distill.md ideate.md draft_linkedin.md draft_hashnode.md retro.md redact_check.md
├── config/           sources.example.yaml terms.example.yaml foraging.example.yaml budget.example.yaml redact.example.yaml
├── evals/            judges/*.md  (datasets live in LangSmith)
└── docs/             how-it-works.md foraging.md  (future blog posts, basically)
```

**`content-agents-state` (private; name via `STATE_REPO` env)**
```
├── config/           sources.yaml terms.yaml foraging.yaml budget.yaml redact.yaml brain.yaml
├── memory/           voice.md winning-patterns.md rejected.md topics-covered.md voice-samples/
├── prompts/          proposed-changes.md   (+ overrides/ if I fork a public prompt)
├── queue/            inbox/ approved/ rejected/ drafted/ published/ saved/
└── data/             items/<type>/<yyyy-mm>.jsonl  hooks.jsonl feedback.jsonl published.jsonl pheromone-history.jsonl
```

Secrets (Trigger.dev env vars): `ANTHROPIC_API_KEY`, `APIFY_TOKEN`, `LANGSMITH_API_KEY`,
`GITHUB_TOKEN` (state repo rw, the work-notes repo ro), `SLACK_WEBHOOK_URL`, `STATE_REPO`,
`BRAIN_REPO`, `GITHUB_WEBHOOK_SECRET`, `SLACK_SIGNING_SECRET` (intake app).

---

## 8. Phases

**Phase 0 — Registry + free ingestion + plumbing**
- Both repos; Trigger.dev project init; env vars; billing limit = plan max; Slack webhook.
- `schemas/`, `registry/`, `cli.ts`. Import my 74 Substacks as `active` (resolver probes
  `<slug>.substack.com` → custom domain → RSS, records `method`). Seed `terms.yaml`
  (gtm engineer, gtm engineering, revops, outbound, clay, pricing, cpq, demo, solutions
  engineer, ai agents, context engineering, build in public…).
- `ingest/substack.ts` backfill 90 days ($0); `ingest/brain.ts` + redaction, eyeball output.
- Voice samples from Hashnode RSS → `memory/voice-samples/`.
- **Done when:** `ingest-distill` runs on schedule, commits to the state repo, candidates
  appear in `sources.yaml`, and a DuckDB query lists top-20 posts by per-author z-score.

**Phase 1 — Distill + Ideate + feedback**
- Distill over the backfill (Haiku, ~$1–2 one-time), LangSmith tracing, pheromone updates.
- Thompson sampling live for Substack. First `ideate` batch + Slack DM.
- GitHub webhook → `feedback-webhook` (approve/reject/rewrite). `ideate-one` for rewrites.
- `intake` via `queue/saved/` first (file door); Slack app door in Phase 2.
- **Done when:** one week of ingest → cards → verdicts → scores in LangSmith, and at least
  one agent-discovered Substack has reached `trial`.

**Phase 2 — LinkedIn both directions**
- Seed ~20–30 LinkedIn creators as `candidate` via `ca sources import` (GTM Substack
  authors on LinkedIn + Lindahl circle); let trials promote them. `ingest-linkedin` weekly
  (`postedLimit: week`, `maxPosts: 10`, ≈ $2.40/mo). `measure` on my profile.
- LinkedIn candidate generation (mentions, reposts, high-reaction commenters).
- Slack intake app → `intake-webhook`; LinkedIn post links fetch via HarvestAPI.
- **Done when:** LinkedIn hooks in the swipe file, outcomes on my posts, first
  agent-proposed LinkedIn source promoted.

**Phase 3 — Draft + Retro**
- `draft` on approve. `retro` Fridays: memory, proposed prompt changes, source
  promotions/demotions, candidate digest, judge-vs-verdict report, Slack DM.
- **Done when:** Monday has cards + drafts, the retro has proposed one prompt change and
  one source change I accepted.

**Phase 4 — Experiments**
- X ingest + `x_query` terms; web search for `person_query` terms.
- `retro` on LangSmith Fleet; Trigger.dev `chat.agent` over the swipe file.
- `docs/foraging.md` → first Hashnode post about the system itself.

---

## 9. Budget guardrails

`budget.yaml`: monthly $ caps per source type and per model; `ingest` checks Apify
month-to-date usage via API and skips paid pulls past $4. Trigger.dev billing limit = plan max.

| Line | Monthly |
|---|---|
| Apify (LinkedIn creators + trials + my profile) | $2–3 (inside $5 credit) |
| Trigger.dev | $0 (≈ $0.30 of $5 credit) |
| Substack, brain, Hashnode RSS | $0 |
| LangSmith Developer | $0 |
| Anthropic API | $3–8 |
| **Total** | **~$5–10** |

## 10. Sources consulted
- Lindahl, "How to build a GTM Engineering brand (do these 5 things)"
- LangChain, "The Art of Loop Engineering" (2026-06-16); LangChain pricing; Managed Deep Agents docs
- Lilian Weng, "Harness Engineering for Self-Improvement" (2026-07-04)
- Apify pricing; CLI reference; `harvestapi/linkedin-profile-posts`, `parsebird/substack-scraper`,
  `apidojo/tweet-scraper`, `curious_coder/linkedin-post-search-scraper`
- Substack public endpoints probed: `/api/v1/posts`, `/api/v1/archive?sort=top`, `/api/v1/posts/<slug>`,
  `/recommendations`; `/api/v1/publication/search` (empty unauthenticated)
- Hashnode, "GraphQL API" announcement (2026-05-13)
- Trigger.dev pricing; docs: scheduled tasks, free-plan minimum window, limits, webhooks, pythonExtension, billing limits
- the work-notes repo README, `claude/nightly-prompt.md`, `claude/routine-bootstraps.md`, sample files
