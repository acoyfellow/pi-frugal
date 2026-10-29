import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [out] = process.argv.slice(2);

function turns(arm) {
  const dir = join(out, `sessions-${arm}`);
  const rows = [];
  for (const file of readdirSync(dir)) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!line) continue;
      const message = JSON.parse(line).message ?? {};
      if (message.role !== "assistant" || !message.usage) continue;
      rows.push({ at: message.timestamp, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite, cost: message.usage.cost?.total ?? 0 });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

const pinged = turns("pinged");
const control = turns("control");
const lastPinged = pinged.at(-1);
const lastControl = control.at(-1);
const summary = {
  pinged,
  control,
  pingedFinalRead: lastPinged?.cacheRead ?? 0,
  pingedFinalWrite: lastPinged?.cacheWrite ?? 0,
  controlFinalRead: lastControl?.cacheRead ?? 0,
  controlFinalWrite: lastControl?.cacheWrite ?? 0,
  pingRefreshesCache: (lastPinged?.cacheRead ?? 0) > (lastPinged?.cacheWrite ?? 0) && (lastControl?.cacheWrite ?? 0) > (lastControl?.cacheRead ?? 0),
  cost: [...pinged, ...control].reduce((sum, row) => sum + row.cost, 0),
};
writeFileSync(join(out, "score.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
