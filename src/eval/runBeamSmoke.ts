import "dotenv/config";
import fs from "fs";
import path from "path";
import { ensureDatabaseReady, ingestSessionMemory, waitForIngestion, recallMemory, flattenGraphContext } from "../hydra/client";
import { abstentionCheck } from "../abstention/abstentionCheck";
import { checkOllama, generateAnswer } from "../llm/client";

type BeamTurn = { role: string; content: string; time_anchor?: string };
type BeamProbe = { question: string; ideal_response?: string; category: string };

function chunks(text: string, size = 2800): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function main() {
  const root = path.join(__dirname, "..", "..", "data", "official", "BEAM", "chats", "100K", "1");
  const chat = JSON.parse(fs.readFileSync(path.join(root, "chat.json"), "utf8"));
  const probes = JSON.parse(fs.readFileSync(path.join(root, "probing_questions", "probing_questions.json"), "utf8")) as Record<string, BeamProbe[]>;
  const userId = "beam-smoke-100k-1";
  const turns: BeamTurn[] = chat.flatMap((batch: any) => batch.turns).flat();
  const transcript = turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n");

  await ensureDatabaseReady();
  await checkOllama();
  const sourceIds: string[] = [];
  for (const [index, part] of chunks(transcript).entries()) {
    const result = await ingestSessionMemory({ userId, sessionId: `beam-100k-1-${index + 1}`, timestamp: turns[0]?.time_anchor ?? new Date().toISOString(), transcript: part });
    sourceIds.push(...(((result.data as any)?.results ?? []).map((item: any) => item.id).filter(Boolean)));
  }
  if (sourceIds.length) await waitForIngestion({ userId, sourceIds, timeoutMs: 10 * 60 * 1000 });

  const selected = Object.entries(probes).flatMap(([category, items]) => items.slice(0, 1).map((item) => ({ ...item, category })));
  const output = [];
  for (const probe of selected) {
    const recalled = await recallMemory({ userId, question: probe.question });
    const { facts, maxChunkScore } = flattenGraphContext(recalled.data);
    const gate = await abstentionCheck(probe.question, facts, maxChunkScore);
    const answer = gate.verdict === "abstain" ? "[ABSTAIN]" : await generateAnswer(probe.question, facts);
    output.push({ category: probe.category, question: probe.question, ideal_response: probe.ideal_response, answer, verdict: gate.verdict, fact_count: facts.length, evidence: facts.slice(0, 5) });
    console.log(`[${probe.category}] ${gate.verdict}: ${answer.slice(0, 220)}`);
  }
  const outputPath = path.join(__dirname, "..", "..", "data", "beam-smoke-results.json");
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`BEAM smoke diagnostics written to ${outputPath}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
