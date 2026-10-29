const [kind, sizeText, answer] = process.argv.slice(2);
const size = Number(sizeText);
const lines = [];

function seeded(index) {
  return ((index * 2654435761) >>> 0).toString(16).padStart(8, "0");
}

if (kind === "log") {
  const failedAt = Math.floor(size * 0.55);
  for (let index = 0; index < size; index++) {
    const status = index === failedAt ? "FAILED" : "ok";
    const orderId = index === failedAt ? answer : String(100000 + index);
    lines.push(`2026-10-29T10:${String(index % 60).padStart(2, "0")} worker=${seeded(index)} order_id=${orderId} status=${status}`);
  }
}

if (kind === "tail") {
  for (let index = 0; index < size; index++) lines.push(`row ${index} value=${seeded(index)}`);
  lines.push(`final line ends with ${answer}`);
}

if (kind === "json") {
  const users = [];
  const adaAt = Math.floor(size * 0.6);
  for (let index = 0; index < size; index++) {
    const isAda = index === adaAt;
    users.push({ name: isAda ? "ada" : `user${index}`, secret: isAda ? answer : seeded(index), team: `t${index % 7}` });
  }
  lines.push(JSON.stringify({ users }, null, 1));
}

if (kind === "errors") {
  const errorCount = Number(answer);
  const step = Math.floor(size / errorCount);
  for (let index = 0; index < size; index++) {
    const isError = index % step === 0 && index / step < errorCount;
    lines.push(`${isError ? "ERROR" : "info"} line ${index} ${seeded(index)}`);
  }
}

process.stdout.write(`${lines.join("\n")}\n`);
