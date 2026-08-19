import "dotenv/config";
import fs from "fs";
import path from "path";
import { ensureDatabaseReady, ingestSessionMemory } from "../hydra/client";

const userId = process.env.DEMO_USER_ID ?? "demo-user";
const root = path.join(__dirname, "..", "..", "data", "official", "BEAM", "chats", "100K", "1");
const maxChunks = Number(process.env.DEMO_BEAM_CHUNKS ?? 2);
const requestedChunks = (process.env.DEMO_BEAM_CHUNK_LIST ?? "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

function split(text: string, size = 2800) {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

async function main() {
  const chat = JSON.parse(fs.readFileSync(path.join(root, "chat.json"), "utf8"));
  const turns = chat.flatMap((batch: any) => batch.turns).flat();
  const transcript = turns.map((turn: any) => `${turn.role}: ${turn.content}`).join("\n");
  await ensureDatabaseReady();
  const allChunks = split(transcript, 2800);
  const selected = requestedChunks.length
    ? requestedChunks.map((number) => ({ number, chunk: allChunks[number - 1] })).filter((item) => item.chunk)
    : allChunks.slice(0, maxChunks).map((chunk, index) => ({ number: index + 1, chunk }));
  for (const item of selected) {
    await ingestSessionMemory({
      userId,
      sessionId: `dataset-beam-100k-1-${item.number}`,
      timestamp: turns[0]?.time_anchor ?? new Date().toISOString(),
      transcript: item.chunk,
    });
    console.log(`Seeded BEAM chunk ${item.number}`);
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.HYDRA_INGEST_PACING_MS ?? 8500)));
  }
  console.log(`BEAM demo seed submitted for ${userId}.`);
}

main().catch((error) => {
  console.error("BEAM demo seed failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
