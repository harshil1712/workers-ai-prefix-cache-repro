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
