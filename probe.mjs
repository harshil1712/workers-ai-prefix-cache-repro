// Probe Workers AI prefix-cache lifetime: the same ~47k-token prompt with the
// same x-session-affinity, after increasing idle gaps (each measured from the
// previous call). Logs one JSON line per call with usage.prompt_tokens_details.
//
// Usage (needs a long-lived API token with Workers AI access; a short-lived
// `wrangler auth token` expires mid-run):
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node probe.mjs
// Optional: MODEL=@cf/... GAPS_S=0,15,60,120,240,480
// Background: README.md
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const MODEL = process.env.MODEL ?? "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const GAPS_S = (process.env.GAPS_S ?? "0,15,60,120,240,480")
  .split(",")
  .map(Number);
if (!ACCOUNT || !TOKEN) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
  process.exit(1);
}
const AFFINITY = `cache-probe-${Date.now()}`;

const filler = Array.from(
  { length: 2500 },
  (_, i) =>
    `Line ${String(i).padStart(5, "0")}: the quick brown fox jumps over the lazy dog near the river bank.`
).join("\n");
const body = {
  messages: [
    {
      role: "system",
      content: `You are a terse assistant. Reference material follows.\n${filler}`
    },
    { role: "user", content: "Reply with the single word OK." }
  ],
  max_tokens: 16
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`affinity=${AFFINITY} model=${MODEL}`);
for (const gap of GAPS_S) {
  if (gap) await sleep(gap * 1000);
  const t0 = Date.now();
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "x-session-affinity": AFFINITY
      },
      body: JSON.stringify(body)
    }
  );
  const json = await res.json();
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      gapS: gap,
      status: res.status,
      ms: Date.now() - t0,
      usage: json.result?.usage ?? json.usage ?? null,
      errors: json.errors?.length ? json.errors : undefined
    })
  );
}
