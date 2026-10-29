# Keep-warm ping: design notes

Status: replay and live check prove the effect. Not built into the extension.

## Evidence

- Replay (12 sessions, on top of spill at 10k): $227.05 to $204.31 with a 4-minute ping that stops after 10 idle minutes. Cache breaks 131 to 86.
- Live (claude-opus-5-5, 59k-token prefix): 3 pings at $0.012 each kept the cache warm across 11 idle minutes. The idle control paid $0.267 to rewrite.
- Real Opus turns, last 14 days: 98% warm under 5 minutes idle, 7% at 5 to 10 minutes, 0% after 10 minutes. The 5-minute time to live is real.

## How an extension can send a ping that is not saved in the session

- `completeSimple(model, context, options)` from `@earendil-works/pi-ai` sends one request outside the agent loop.
- `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)` gives the auth for the active model.
- `buildSessionContext(ctx.sessionManager.getBranch())` plus `convertToLlm` gives the messages for the current branch.
- `ctx.getSystemPrompt()` gives the system prompt.

## The hard part: the ping prefix must match the next real request byte for byte

A cache read only happens when the request prefix is identical: system prompt, tool declarations and messages. If the ping
differs at all (tools in another order, another tool schema, other cache-control markers), it writes a new cache entry,
which costs a full write each time and does not help the next real turn.

The tool declarations are the risk. The extension API exposes tool names and info, but the exact serialized tool list
that the agent loop sends is built inside Pi. A ping built from `getAllTools()` may not serialize the same way.

## Proof before turning it on

1. Build the ping with the parts above.
2. In a real session: run one turn, wait 3 minutes, send a ping, wait 3 minutes, run one turn.
3. Pass only if the ping's usage shows cacheRead near the full context and cacheWrite near zero, and the final real turn does too.
4. If the ping shows a large cacheWrite, the prefix does not match: stop, do not ship.

## Limits

- Pings run only while Pi is open and idle. Stop after 10 minutes of idle time, the replay optimum.
- Never ping during a run, during compaction, or when the context is small (under 20k tokens the rewrite is cheap).
- Off by default. Turn it on with an env var, like spill.
