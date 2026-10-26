// Workers AI prefix-cache expiry repro, as a Worker.
//
// Same probe as ../probe.mjs, but calls go through the Workers AI binding
// (env.AI.run + extraHeaders: { "x-session-affinity" }) from inside a Worker.
// The run spans ~16 minutes of idle gaps, so it's a Workflow: step.sleep() for
// each gap (measured from the end of the previous call, like probe.mjs), then
// one step.do() per model call.
//
// Routes:
//   POST /probe?model=@cf/...&gaps=0,15,60,120,240,480  -> start a run
//   GET  /probe/:id                                     -> status + results
//   POST /once?affinity=...&model=@cf/...               -> one call, inline
//   POST /think?mode=default|createAI|none&gaps=...     -> start a Think agent run
//   GET  /think/:name                                   -> per-turn results
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { buildSystemPrompt } from "./prompt";
import type { ThinkMode } from "./agent";

export { ProbeAgent } from "./agent";

type ProbeParams = { model: string; gapsS: number[]; affinity: string; salt: string };

type CallResult = {
	at: string;
	gapS: number;
	ms: number;
	ok: boolean;
	promptTokens?: number;
	cachedTokens?: number;
	cachedPct?: number;
	usage?: Record<string, any> | null;
	error?: string;
};

const body = (salt: string) => ({
	messages: [
		{
			role: "system",
			content: buildSystemPrompt(salt),
		},
		{ role: "user", content: "Reply with the single word OK." },
	],
	max_tokens: 16,
});

// The model may not be in the generated AiModels map yet, so use a loose signature.
type LooseAi = {
	run(model: string, inputs: unknown, options?: AiOptions): Promise<any>;
};

async function callModel(env: Env, model: string, affinity: string, salt: string, gapS: number): Promise<CallResult> {
	const t0 = Date.now();
	try {
		const res = await (env.AI as unknown as LooseAi).run(model, body(salt), {
			extraHeaders: { "x-session-affinity": affinity },
		});
		const usage = res?.usage ?? null;
		const promptTokens: number | undefined = usage?.prompt_tokens;
		const cachedTokens: number | undefined = usage?.prompt_tokens_details?.cached_tokens;
		return {
			at: new Date().toISOString(),
			gapS,
			ms: Date.now() - t0,
			ok: true,
			promptTokens,
			cachedTokens,
			cachedPct:
				promptTokens && cachedTokens !== undefined
					? Math.round((cachedTokens / promptTokens) * 1000) / 10
					: undefined,
			usage,
		};
	} catch (err) {
		return {
			at: new Date().toISOString(),
			gapS,
			ms: Date.now() - t0,
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export class PrefixCacheProbe extends WorkflowEntrypoint<Env, ProbeParams> {
	async run(event: WorkflowEvent<ProbeParams>, step: WorkflowStep) {
		const { model, gapsS, affinity, salt } = event.payload;
		const results: CallResult[] = [];

		for (const [i, gapS] of gapsS.entries()) {
			if (gapS > 0) await step.sleep(`idle ${i}: ${gapS}s`, gapS * 1000);

			// No retries: a retry would be a second call right away and would
			// hide the cold prefill we're trying to measure. Errors come back
			// as data instead of being thrown.
			const r = await step.do(
				`call ${i} (after ${gapS}s idle)`,
				{ retries: { limit: 0, delay: 0 }, timeout: "5 minutes" },
				() => callModel(this.env, model, affinity, salt, gapS),
			);
			console.log(JSON.stringify({ affinity, model, ...r, usage: undefined }));
			results.push(r);
		}

		return { affinity, model, results };
	}
}

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});

export default {
	async fetch(req, env): Promise<Response> {
		const url = new URL(req.url);
		const model = url.searchParams.get("model") ?? env.DEFAULT_MODEL;

		if (req.method === "POST" && url.pathname === "/probe") {
			const gapsS = (url.searchParams.get("gaps") ?? env.DEFAULT_GAPS_S).split(",").map(Number);
			if (gapsS.some((g) => !Number.isFinite(g) || g < 0)) return json({ error: "bad gaps" }, 400);
			const affinity = url.searchParams.get("affinity") ?? `cache-probe-${Date.now()}`;
			const salt = url.searchParams.get("salt") ?? affinity;
			const instance = await env.PROBE.create({ params: { model, gapsS, affinity, salt } });
			return json({
				id: instance.id,
				affinity,
				salt,
				model,
				gapsS,
				expectedMinutes: Math.round(gapsS.reduce((a, b) => a + b, 0) / 6) / 10,
				status: `${url.origin}/probe/${instance.id}`,
			});
		}

		const m = url.pathname.match(/^\/probe\/([^/]+)$/);
		if (req.method === "GET" && m) {
			const instance = await env.PROBE.get(m[1]);
			const s = await instance.status();
			const out = s.output as { results?: CallResult[] } | undefined;
			return json({
				status: s.status,
				error: s.error,
				// Compact table once finished; full usage objects under `output`.
				table: out?.results?.map(({ gapS, ms, cachedTokens, promptTokens, cachedPct, error }) => ({
					gapS,
					ms,
					cached: cachedTokens !== undefined ? `${cachedTokens}/${promptTokens} (${cachedPct}%)` : undefined,
					error,
				})),
				output: s.output,
			});
		}

		// Single call, inline. Handy to poke the cache by hand at your own intervals:
		//   curl -X POST "$URL/once?affinity=me-1"
		if (req.method === "POST" && url.pathname === "/once") {
			const affinity = url.searchParams.get("affinity") ?? `cache-probe-${Date.now()}`;
			const salt = url.searchParams.get("salt") ?? affinity;
			return json({ affinity, salt, model, ...(await callModel(env, model, affinity, salt, 0)) });
		}

		if (req.method === "POST" && url.pathname === "/think") {
			const mode = (url.searchParams.get("mode") ?? "default") as ThinkMode;
			if (!["default", "createAI", "none"].includes(mode)) return json({ error: "bad mode" }, 400);
			const gapsS = (url.searchParams.get("gaps") ?? env.DEFAULT_GAPS_S).split(",").map(Number);
			if (gapsS.some((g) => !Number.isFinite(g) || g < 0)) return json({ error: "bad gaps" }, 400);
			const name = url.searchParams.get("name") ?? `think-${mode}-${Date.now()}`;
			const salt = url.searchParams.get("salt") ?? name;
			const agent = await getAgentByName(env.ProbeAgent, name);
			const started = await agent.start({ model, mode, gapsS, salt });
			return json({
				name,
				mode,
				model,
				gapsS,
				salt,
				...started,
				results: `${url.origin}/think/${name}`,
			});
		}

		const t = url.pathname.match(/^\/think\/([^/]+)$/);
		if (req.method === "GET" && t) {
			const agent = await getAgentByName(env.ProbeAgent, t[1]);
			return json(await agent.results());
		}

		return json(
			{
				routes: {
					"POST /think?mode=default|createAI|none&gaps=&model=": "start a Think agent run",
					"GET /think/:name": "per-turn results",
					"POST /probe?model=&gaps=&affinity=": "start a Workflow run (default gaps " + env.DEFAULT_GAPS_S + ")",
					"GET /probe/:id": "status + results",
					"POST /once?affinity=&model=": "one inline call",
				},
			},
			404,
		);
	},
} satisfies ExportedHandler<Env>;
