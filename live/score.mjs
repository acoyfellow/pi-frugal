import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [out, label, spill] = process.argv.slice(2);
const tasks = JSON.parse(readFileSync(new URL("./tasks.json", import.meta.url), "utf8"));
const times = Object.fromEntries(
  readFileSync(join(out, "times.txt"), "utf8").trim().split("\n").map((line) => line.split(" ")).map(([id, seconds]) => [id, Number(seconds)]),
);

function sessionCost(id) {
  const dir = join(out, `sessions-${id}`);
  if (!existsSync(dir)) return { cost: 0, toolCalls: 0 };
  let cost = 0;
  let toolCalls = 0;
  for (const file of readdirSync(dir)) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line);
      const message = entry.message ?? {};
      if (message.role === "assistant") cost += message.usage?.cost?.total ?? 0;
      if (message.role === "toolResult") toolCalls++;
    }
  }
  return { cost, toolCalls };
}

function normalize(text) {
  return text.replace(/[`*"'.]/g, " ").replace(/\s+/g, " ").trim();
}

const results = tasks.filter((task) => task.id in times).map((task) => {
  const reply = existsSync(join(out, `${task.id}.txt`)) ? readFileSync(join(out, `${task.id}.txt`), "utf8") : "";
  const lastLine = normalize(reply).split(" ").slice(-task.expect.split(" ").length).join(" ");
  const { cost, toolCalls } = sessionCost(task.id);
  return { id: task.id, pass: lastLine === task.expect, reply: reply.trim().slice(-120), cost, toolCalls, seconds: times[task.id] ?? null };
});

const summary = {
  label,
  spill: spill || null,
  at: new Date().toISOString(),
  passed: results.filter((result) => result.pass).length,
  total: results.length,
  cost: results.reduce((sum, result) => sum + result.cost, 0),
  seconds: results.reduce((sum, result) => sum + (result.seconds ?? 0), 0),
  toolCalls: results.reduce((sum, result) => sum + result.toolCalls, 0),
  results,
};
writeFileSync(join(out, "score.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
