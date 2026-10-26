// Think-based variant of the probe: the same ~47.5k-token system prompt, but
// sent by a real Think agent (Durable Object) with the conversation growing
// turn by turn, like a multi-turn chat agent.
//
// Turns are fired with saveMessages() from this.schedule() alarms, so between
// turns the DO is idle and can hibernate/evict exactly like a production agent
// waiting for the user. Each turn records cached tokens and time to first
// chunk (what users feel as a slow first token).
//
// `mode` picks how getModel() builds the model, since that decides whether an
// x-session-affinity header is sent at all:
//   default  - return the model id string; Think resolves it with
//              sessionAffinity: this.sessionAffinity (the DO id).
//   createAI - createAI({ binding })(model, { sessionAffinity: this.sessionAffinity })
//   none     - createAI({ binding })(model), the getting-started pattern,
//              which sends NO affinity header.
import { Think, type StepContext, type ChunkContext } from "@cloudflare/think";
import { createAI } from "agents/models/ai-sdk";
import { buildSystemPrompt } from "./prompt";

export type ThinkMode = "default" | "createAI" | "none";

export type ProbeConfig = {
	model: string;
	mode: ThinkMode;
	gapsS: number[];
	salt: string;
	startedAt: string;
	done?: boolean;
};

type TurnRow = {
	turn: number;
	gap_s: number;
	at: string;
	status: string;
	error: string | null;
	ttfc_ms: number | null;
	total_ms: number;
	input_tokens: number | null;
	cached_tokens: number | null;
	raw_usage: string | null;
	provider_metadata: string | null;
	woke_cold: number;
};

export class ProbeAgent extends Think<Env> {
	// One model call per turn so each row is exactly one prefill.
	maxSteps = 1;

	// Per-turn scratch. Lives only for the DO activation running the turn.
	#cur?: { i: number; t0: number; firstChunkAt?: number; step?: StepContext };
	// Set when this isolate instance is fresh: tells us whether the DO was
	// evicted/hibernated between turns.
	#fresh = true;

	async onStart() {
		this.sql`CREATE TABLE IF NOT EXISTS probe_turns (
			turn INTEGER PRIMARY KEY, gap_s INTEGER, at TEXT, status TEXT, error TEXT,
			ttfc_ms INTEGER, total_ms INTEGER, input_tokens INTEGER, cached_tokens INTEGER,
			raw_usage TEXT, provider_metadata TEXT, woke_cold INTEGER)`;
	}

	#config() {
		return this.getConfig<ProbeConfig>();
	}

	getModel() {
		const c = this.#config();
		const model = c?.model ?? this.env.DEFAULT_MODEL;
		const ai = createAI({ binding: this.env.AI });
		type Id = Parameters<typeof ai>[0] & string;
		switch (c?.mode) {
			case "none":
				return ai(model as Id);
			case "createAI":
				return ai(model as Id, { sessionAffinity: this.sessionAffinity });
			default:
				return model;
		}
	}

	getSystemPrompt() {
		return buildSystemPrompt(this.#config()?.salt ?? "");
	}

	onChunk(ctx: ChunkContext) {
		// First content chunk (text, reasoning or tool call), not stream metadata.
		const t = (ctx.chunk as { type: string }).type;
		const content = t === "text-delta" || t === "reasoning-delta" || t === "tool-input-start" || t === "tool-call";
		if (content && this.#cur && this.#cur.firstChunkAt === undefined) this.#cur.firstChunkAt = Date.now();
	}

	onStepFinish(ctx: StepContext) {
		if (this.#cur && this.#cur.step === undefined) this.#cur.step = ctx;
	}

	/** RPC: configure and kick off a run. */
	async start(cfg: Omit<ProbeConfig, "startedAt">) {
		if (this.#config()) throw new Error("this agent already ran; use a new name");
		this.configure<ProbeConfig>({ ...cfg, startedAt: new Date().toISOString() });
		await this.schedule(0, "probeTurn", { i: 0 });
		return { sessionAffinity: cfg.mode === "none" ? null : this.sessionAffinity };
	}

	/** Scheduled callback: one user turn, then schedule the next after its gap. */
	async probeTurn({ i }: { i: number }) {
		const c = this.#config();
		if (!c) return;
		const wokeCold = this.#fresh;
		this.#fresh = false;
		this.#cur = { i, t0: Date.now() };

		let status = "error";
		let error: string | null = null;
		try {
			const res = await this.saveMessages([
				{
					id: crypto.randomUUID(),
					role: "user",
					parts: [{ type: "text", text: `Turn ${i}. Reply with the single word OK.` }],
				},
			]);
			status = res.status;
			error = res.error ?? null;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}

		const { t0, firstChunkAt, step } = this.#cur;
		const usage = step?.usage as
			| (StepContext["usage"] & { cachedInputTokens?: number })
			| undefined;
		const row: TurnRow = {
			turn: i,
			gap_s: i === 0 ? 0 : c.gapsS[i],
			at: new Date().toISOString(),
			status,
			error,
			ttfc_ms: firstChunkAt ? firstChunkAt - t0 : null,
			total_ms: Date.now() - t0,
			input_tokens: usage?.inputTokens ?? null,
			cached_tokens: usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens ?? null,
			raw_usage: usage ? JSON.stringify(usage) : null,
			provider_metadata: step?.providerMetadata ? JSON.stringify(step.providerMetadata) : null,
			woke_cold: wokeCold ? 1 : 0,
		};
		this.sql`INSERT OR REPLACE INTO probe_turns VALUES (${row.turn}, ${row.gap_s}, ${row.at}, ${row.status},
			${row.error}, ${row.ttfc_ms}, ${row.total_ms}, ${row.input_tokens}, ${row.cached_tokens},
			${row.raw_usage}, ${row.provider_metadata}, ${row.woke_cold})`;
		console.log(JSON.stringify({ agent: this.name, mode: c.mode, ...row, raw_usage: undefined, provider_metadata: undefined }));
		this.#cur = undefined;

		if (i + 1 < c.gapsS.length) await this.schedule(c.gapsS[i + 1], "probeTurn", { i: i + 1 });
		else this.configure<ProbeConfig>({ ...c, done: true });
	}

	/** RPC: config + per-turn results. */
	async results() {
		const c = this.#config();
		const rows = this.sql<TurnRow>`SELECT * FROM probe_turns ORDER BY turn`;
		return {
			config: c,
			sessionAffinity: c?.mode === "none" ? null : this.sessionAffinity,
			done: !!c?.done,
			table: rows.map((r) => ({
				turn: r.turn,
				gapS: r.gap_s,
				status: r.status,
				ttfcMs: r.ttfc_ms,
				totalMs: r.total_ms,
				cached:
					r.input_tokens != null
						? `${r.cached_tokens ?? "?"}/${r.input_tokens} (${
								r.cached_tokens != null ? Math.round((r.cached_tokens / r.input_tokens) * 1000) / 10 : "?"
							}%)`
						: null,
				wokeCold: !!r.woke_cold,
				error: r.error ?? undefined,
			})),
			rows: rows.map((r) => ({
				...r,
				raw_usage: r.raw_usage ? JSON.parse(r.raw_usage) : null,
				provider_metadata: r.provider_metadata ? JSON.parse(r.provider_metadata) : null,
			})),
		};
	}
}
