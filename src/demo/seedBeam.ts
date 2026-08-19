import "dotenv/config";
import fs from "fs";
import path from "path";
import { ensureDatabaseReady, ingestSessionMemory } from "../hydra/client";

const userId = process.env.DEMO_USER_ID ?? "demo-user";
const root = path.join(__dirname, "..", "..", "data", "official", "BEAM", "chats", "100K", "1");
const maxChunks = Number(process.env.DEMO_BEAM_CHUNKS ?? 2);

function split(text: string, size = 2800) {
  const chunks: string[] = [];
  for (let i = 0; i < text.length && chunks.length < maxChunks; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

async function main() {
  const chat = JSON.parse(fs.readFileSync(path.join(root, "chat.json"), "utf8"));
  const turns = chat.flatMap((batch: any) => batch.turns).flat();
  const transcript = turns.map((turn: any) => `${turn.role}: ${turn.content}`).join("\n");
  await ensureDatabaseReady();
  for (const [index, chunk] of split(transcript).entries()) {
    await ingestSessionMemory({
      userId,
      sessionId: `dataset-beam-100k-1-${index + 1}`,
      timestamp: turns[0]?.time_anchor ?? new Date().toISOString(),
      transcript: chunk,
    });
    console.log(`Seeded BEAM chunk ${index + 1}`);
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.HYDRA_INGEST_PACING_MS ?? 8500)));
  }
  console.log(`BEAM demo seed submitted for ${userId}.`);
}

main().catch((error) => {
  console.error("BEAM demo seed failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
