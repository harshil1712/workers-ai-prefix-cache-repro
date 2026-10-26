// ~47.5k-token prompt, same as ../../probe.mjs except for an optional salt at
// the very start. The prefix cache matches on tokens (affinity only picks the
// replica), so without a salt, concurrent or back-to-back runs could warm the
// cache for each other. An empty salt gives exactly probe.mjs's prompt.
const filler = Array.from(
	{ length: 2500 },
	(_, i) =>
		`Line ${String(i).padStart(5, "0")}: the quick brown fox jumps over the lazy dog near the river bank.`,
).join("\n");

export const buildSystemPrompt = (salt: string) =>
	`${salt ? `[run ${salt}] ` : ""}You are a terse assistant. Reference material follows.\n${filler}`;
