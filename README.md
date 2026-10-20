# content-agents

Loop-driven content agents for LinkedIn + Hashnode: a swipe file distilled from the newsletters and
creators you follow, idea cards seeded from your own work notes, and an ant-colony foraging loop
that discovers new sources on its own. Runs on free tiers (Trigger.dev, LangSmith, Substack's public
API, Apify's monthly credit) for roughly $5–10/month in model calls.

**Status: Phase 1.** Registry, ingestion, swipe-file distillation, twice-weekly idea cards in Slack, and the verdict loop run on Trigger.dev.
LinkedIn ingestion, drafting, and the weekly retro are next. See [PLAN.md](PLAN.md).

## How it works (short)

1. **Registry** — every source and search term is a record with a lifecycle
   (`candidate → trial → active → paused → retired`), provenance, and a pheromone score.
2. **Ingest** — daily, Thompson-sampled across sources (most of the budget to proven ones, a slice
   to exploration, one random pick per run). Substack via its public JSON API, LinkedIn via Apify,
   plus your own notes repo with redaction.
3. **Distill** — a cheap model turns each post into a swipe-file record: hook, reusable hook
   template, format, topics, per-author engagement z-score, why it worked.
4. **Ideate → Review → Draft** — idea cards land in a queue; you mark approve / reject / rewrite by
   commit; approvals become drafts in your voice. You publish by hand.
5. **Measure → Retro** — outcomes are written back onto cards; a weekly retro updates memory,
   proposes prompt changes (never applies them), and promotes or demotes sources.

Private state (your sources, items, cards, memory) lives in a separate private repo pointed to by
`STATE_REPO`. Nothing personal is hardcoded here.

## Quick start

```bash
npm install
cp .env.example .env            # fill in what you have; Phase 0 needs none of the API keys
git clone <your-private-state-repo> state   # or start from config/*.example.yaml
npm run ca -- sources add https://someone.substack.com --active
npm run ca -- sources resolve && npm run ca -- sources verify
npm run ca -- ingest substack --all --days 90
npm run ca -- top -n 20          # per-author z-score leaderboard (DuckDB over JSONL)
npm run dev                      # trigger.dev dev server; run `ingest-distill` from the dashboard
```

## CLI

`ca sources ls|add|set|resolve|verify|decay|plan` · `ca terms ls|add` · `ca ingest substack|brain` ·
`ca distill` · `ca hooks` · `ca ideate` · `ca feedback` · `ca top` · `ca sql "<query>"` · `ca stats`

## Design references

- LangChain, *The Art of Loop Engineering* — agent → verification → event-driven → hill-climbing loops
- Lilian Weng, *Harness Engineering for Self-Improvement* — filesystem as memory, evaluator outside the loop, diversity collapse
- Alex Lindahl, *5 strategic ways to build your GTME brand* — the swipe-file practice this automates

MIT.
