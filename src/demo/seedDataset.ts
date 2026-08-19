import "dotenv/config";
import fs from "fs";
import path from "path";
import { ensureDatabaseReady, ingestSessionMemory } from "../hydra/client";

type Instance = {
  question_id: string;
  sessions: { session_id: string; timestamp: string; turns: { role: string; content: string }[] }[];
};

const userId = process.env.DEMO_USER_ID ?? "demo-user";
const limit = Number(process.env.DEMO_DATASET_LIMIT ?? 3);
const dataPath = path.join(__dirname, "..", "..", "data", "longmemeval_subset.json");

async function main() {
  const instances = JSON.parse(fs.readFileSync(dataPath, "utf8")) as Instance[];
  await ensureDatabaseReady();
  let count = 0;
  for (const instance of instances.slice(0, limit)) {
    for (const session of instance.sessions) {
      const transcript = session.turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n");
      await ingestSessionMemory({
        userId,
        sessionId: `dataset-${instance.question_id}-${session.session_id}`,
        timestamp: session.timestamp,
        transcript,
      });
      count += 1;
      console.log(`Seeded ${instance.question_id}/${session.session_id}`);
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.HYDRA_INGEST_PACING_MS ?? 8500)));
    }
  }
  console.log(`Dataset demo seed submitted: ${count} sessions for ${userId}.`);
}

main().catch((error) => {
  console.error("Dataset demo seed failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
