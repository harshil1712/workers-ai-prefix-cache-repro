# Workers AI prefix cache expires after ~2–4 minutes idle

Repro for multi-turn agents on Workers AI: even with a stable
`x-session-affinity`, the prefix cache is gone after a few idle minutes. The
next turn then prefills the whole conversation cold, which users notice as a
slow first token.

## Run it

Needs Node 18+ and a long-lived API token with Workers AI access. A
short-lived `wrangler auth token` expires mid-run.

```sh
CLOUDFLARE_ACCOUNT_ID=<account> CLOUDFLARE_API_TOKEN=<token> node probe.mjs
```

The script sends one fixed ~47.5k-token prompt with one fixed
`x-session-affinity` to `/ai/run/<model>` after idle gaps of 0 s, 15 s, 1, 2, 4
and 8 minutes. Each gap is measured from the previous call. It prints one JSON
line per call with `usage.prompt_tokens_details.cached_tokens`. A full run takes
about 16 minutes. Optional settings: `MODEL=@cf/...`, `GAPS_S=0,15,60,...`.

## Run it as a Worker (binding path)

[`worker/`](worker/) runs the same probe from inside a Worker through the
Workers AI binding (`env.AI.run(model, body, { extraHeaders: {
"x-session-affinity": ... } })`), with the same prompt and gaps. Because the
run takes ~16 minutes, it's a Workflow: `step.sleep` for each idle gap, then one
`step.do` per call (retries off, so a retry can't hide a cold prefill). No API
token is needed.

```sh
cd worker && npm i && npx wrangler deploy
URL=https://workers-ai-prefix-cache-repro.<subdomain>.workers.dev

curl -X POST "$URL/probe"                       # defaults: deepseek-v4.1-flash, 0,15,60,120,240,480
curl -X POST "$URL/probe?gaps=0,180,180,300"    # custom gaps / ?model=@cf/...
curl "$URL/probe/<id>"                          # status + table once complete
curl -X POST "$URL/once?affinity=my-session"    # one inline call, to poke the cache by hand
```

Each call is also logged as a JSON line (`npx wrangler tail`).

### Think agent variant

`POST /think?mode=...` runs the same probe through a real Think agent
([`worker/src/agent.ts`](worker/src/agent.ts)). The agent uses `maxSteps = 1`
and a growing conversation. Turns are fired with `saveMessages()` from
`this.schedule()` alarms, so the DO is evicted between turns like a production
agent. Each turn records cached tokens and time to first chunk.
`GET /think/<name>` returns the table.

`mode` controls how `getModel()` builds the model, which decides whether
`x-session-affinity` is sent at all:

| mode | `getModel()` returns | affinity header |
|---|---|---|
| `default` | `"@cf/..."` string (Think resolves it) | DO id (`this.sessionAffinity`) |
| `createAI` | `createAI({ binding })(id, { sessionAffinity: this.sessionAffinity })` | DO id |
| `none` | `createAI({ binding })(id)` (the getting-started pattern) | **none** |

### Worker results (2026-10-26)

Raw: [`worker/results-2026-10-26-binding.jsonl`](worker/results-2026-10-26-binding.jsonl),
[`worker/results-2026-10-26-think.jsonl`](worker/results-2026-10-26-think.jsonl).

**Run A (~20:24 UTC), binding Workflow: no expiry.** All calls hit 99.9% after
4-, 8- and 10-minute idle gaps, including isolated single-gap runs (cold, then
3, 5 or 10 min idle). Two fully cached calls still took 19-25 s.

**Run B (~20:51 UTC), four runs in parallel: expiry reproduced at 8 min in all
of them.**

| Idle gap | Think `default` | Think `createAI` | Think `none` (no affinity) | Binding Workflow |
|---|---|---|---|---|
| cold | 0% | 0% | 0% | 0% |
| 15 s - 4 min | 99.7-99.8% | 99.7-99.8% | 99.8-99.9% | 99.8% |
| 8 min | **0%** (TTFC 5.4 s) | **16%** (6.7 s) | **8.5%** (5.4 s) | **34%** (3.4 s) |

Takeaways:
- Not Think-specific. The plain binding call loses the cache too.
- Not a fixed TTL. A 10-minute gap kept the cache in run A. In run B, four
  independent sessions lost theirs within the same 8-minute window
  (20:59 to 21:07 UTC). That points to replica-wide eviction (load or memory
  pressure), not a per-session timer.
- Affinity made no measurable difference here. `none` hit the cache as often
  as the DO-id affinity modes. But the getting-started `getModel()` pattern
  (`createAI({ binding })(id)`) silently sends no affinity header, which is
  worth documenting.

## Results (2026-10-26, `@cf/deepseek-ai/deepseek-v4.1-flash-1017`)

Raw output: [`results-2026-10-26.jsonl`](results-2026-10-26.jsonl).

| Idle gap | Cached tokens | Latency |
|---|---|---|
| none (cold) | 0 / 47,548 | 6.6 s |
| 15 s | 47,424 (99.7%) | 1.7 s |
| 1 min | 47,424 (99.7%) | 1.8 s |
| 2 min | 47,424 (99.7%) | 1.9 s |
| 4 min | 10,816 (23%) | 4.7 s |

The 8-minute call in that run failed on token expiry and still needs a rerun.

Production confirms it: in a Think-based chat agent over 7 days, the first
model call of each turn averaged 45% cached tokens. Later calls in the same
turn averaged 92%. Most turns start after a pause longer than the cache
lifetime.

## Feedback: Workers AI

1. The [prompt caching docs](https://developers.cloudflare.com/workers-ai/features/prompt-caching/)
   don't give a cache lifetime. They only say affinity "increases the
   likelihood" of a hit, and there is no TTL or retention setting.
2. Ask: document the lifetime, and offer a way to extend it (comparable to
   Anthropic `cache_control` TTLs or OpenAI `prompt_cache_retention`), even at a
   higher cached-token rate.
3. Question: affinity held for the whole run, yet the cache dropped. Is the
   eviction memory pressure on the replica? If so, a routing TTL alone
   wouldn't help.

## Feedback: Agents SDK / Think

1. `waitForMcpConnections` defaults to `false`. After a Durable Object wakes
   from hibernation, the first turn can run before MCP reconnects. The tools
   built from MCP (codemode connectors, `includeMcpTools`) are then missing, the
   tool set changes between turns, and the prefix cache breaks. That goes
   against the Workers AI advice to keep tool definitions consistent. Suggest
   defaulting it on when MCP servers are registered, or documenting the impact.
2. There is no public API to build a turn's model request (system, tools,
   messages) without running the turn, so apps can't pre-warm the cache when a
   user opens a chat or starts typing. A built-in `prewarm()` would cover the
   Workers AI gap.
3. `createAI` (`agents/models/ai-sdk`) exposes `sessionAffinity` but no
   provider prompt-cache retention options, so moving to a provider with a
   longer cache isn't a config change.
