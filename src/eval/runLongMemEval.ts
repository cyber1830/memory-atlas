import "dotenv/config";
import fs from "fs";
import path from "path";
import { ensureDatabaseReady, ingestSessionMemory, recallMemory, flattenGraphContext } from "../hydra/client";
import { abstentionCheck } from "../abstention/abstentionCheck";
import { checkOllama, generateAnswer, naiveLongContextAnswer } from "../llm/client";
import { RetrievedFact } from "../types";

/**
 * Expects a LongMemEval-format JSON file at data/longmemeval_subset.json:
 * [
 *   {
 *     "question_id": "...",
 *     "question": "...",
 *     "answer": "...",
 *     "question_type": "single-session-user" | "multi-session" | "temporal-reasoning" | "knowledge-update" | "abstention" | ...,
 *     "sessions": [ { "session_id": "...", "timestamp": "...", "turns": [...] }, ... ]
 *   },
 *   ...
 * ]
 *
 * Download the real dataset from https://github.com/xiaowu0162/LongMemEval
 * and trim to a subset for hackathon-time iteration (start with ~10-20
 * instances covering each question_type before scaling up).
 *
 * Each instance gets its own HydraDB collection (question_id, prefixed)
 * so runs are isolated and repeatable without cross-contaminating
 * another instance's memory graph.
 *
 * This harness is intentionally a rough scoring pass (substring /
 * keyword match against gold answer) — good enough to produce a
 * directional accuracy table for the demo. Swap in the official
 * LongMemEval scoring script for a rigorous final number.
 */

interface EvalInstance {
  question_id: string;
  question: string;
  answer: string;
  question_type: string;
  sessions: { session_id: string; timestamp: string; turns: { role: string; content: string }[] }[];
}

function sessionToTranscript(turns: { role: string; content: string }[]): string {
  return turns.map((t) => `${t.role}: ${t.content}`).join("\n");
}

// HydraDB enforces a 1,000-token per-request ingestion budget. Keep a safety
// margin and split only the transport payload; the original session timestamp
// and a stable chunk suffix preserve provenance during retrieval.
function chunkTranscript(transcript: string, maxChars = 2800): string[] {
  const chunks: string[] = [];
  // Keep a small overlap so a fact introduced in one turn remains connected
  // to the follow-up turn when a long session crosses a transport boundary.
  const overlap = 600;
  for (let i = 0; i < transcript.length; i += maxChars - overlap) chunks.push(transcript.slice(i, i + maxChars));
  return chunks;
}

function parseRetryAfterSeconds(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/retry in (\d+(?:\.\d+)?)\s*second/i);
  return match ? Number(match[1]) : null;
}

function isRateLimited(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|RATE_LIMITED/i.test(message);
}

async function ingestWithRetry(params: Parameters<typeof ingestSessionMemory>[0], attempts = 10): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await ingestSessionMemory(params);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      if (isRateLimited(error)) {
        const hinted = parseRetryAfterSeconds(error);
        const waitMs = (hinted ?? 5) * 1000 + 500;
        console.warn(`[hydra] rate limited, waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${attempts})`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      } else await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

function roughMatch(predicted: string, gold: string): boolean {
  const p = predicted.toLowerCase();
  const g = gold.toLowerCase().trim();
  if (!g) return false;
  return p.includes(g);
}

function addSessionContext(question: string, sessions: EvalInstance["sessions"], facts: RetrievedFact[]): RetrievedFact[] {
  const ignored = new Set("what where when who why how did does is are was were the a an my me i user your to of in on for with and or".split(" "));
  const terms = (question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((term) => !ignored.has(term));
  const additions: RetrievedFact[] = [];
  for (const session of sessions) {
    for (let index = 0; index < session.turns.length; index += 1) {
      const score = terms.filter((term) => session.turns[index].content.toLowerCase().includes(term)).length;
      if (score === 0) continue;
      const start = Math.max(0, index - 3);
      const end = Math.min(session.turns.length - 1, index + 3);
      const window = session.turns.slice(start, end + 1).map((turn) => `${turn.role}: ${turn.content.trim()}`).join("\n");
      additions.push({ sourceEntity: "session", predicate: "contains_context_window", targetEntity: window.slice(0, 5000), evidenceText: window, sessionId: session.session_id, timestamp: session.timestamp, relevance: 0.8 + score * 0.1 });
    }
  }
  const uniqueAdditions = [...new Map(additions.map((fact) => [`${fact.sessionId}:${fact.evidenceText}`, fact])).values()];
  return [...uniqueAdditions.sort((a, b) => b.relevance - a.relevance), ...facts].slice(0, 30);
}

async function runOurSystem(instance: EvalInstance) {
  const userId = `eval-${instance.question_id}`.replace(/[^a-zA-Z0-9_-]/g, "_");

  if (process.env.EVAL_REUSE !== "1") for (const session of instance.sessions) {
    const chunks = chunkTranscript(sessionToTranscript(session.turns));
    for (let index = 0; index < chunks.length; index += 1) {
      await ingestWithRetry({
        userId,
        sessionId: `${session.session_id}__chunk_${index + 1}`,
        timestamp: session.timestamp,
        transcript: chunks[index],
      });
      // Avoid HydraDB's per-second request budget when a session has many chunks.
      const pacingMs = Number(process.env.HYDRA_INGEST_PACING_MS ?? 8500);
      await new Promise((resolve) => setTimeout(resolve, pacingMs));
    }
  }

  // Ingestion is processed asynchronously by HydraDB — give it a moment
  // before querying. For a real run, poll client.context.status per
  // source instead of a flat sleep; this is the hackathon-time shortcut.
  if (process.env.EVAL_REUSE !== "1") await new Promise((r) => setTimeout(r, 4000));

  const recallResult = await recallMemory({ userId, question: instance.question });
  const { facts: graphFacts, maxChunkScore } = flattenGraphContext(recallResult.data);
  const facts = addSessionContext(instance.question, instance.sessions, graphFacts);
  if (process.env.DEBUG_RETRIEVAL === "1") {
    console.log(`[retrieval] ${instance.question_id} facts=${facts.length}`);
    for (const fact of facts.slice(0, 30)) console.log(`[retrieval] ${fact.predicate}: ${(fact.evidenceText ?? fact.targetEntity).slice(0, 240)}`);
  }
  const abstention = await abstentionCheck(instance.question, facts, maxChunkScore);

  if (abstention.verdict === "abstain") {
    return { predicted: "[ABSTAIN]", verdict: abstention.verdict, factCount: facts.length, reason: abstention.reason };
  }
  const answer = await generateAnswer(instance.question, facts);
  return { predicted: answer, verdict: abstention.verdict, factCount: facts.length, reason: abstention.reason };
}

async function runNaiveBaseline(instance: EvalInstance) {
  if (process.env.EVAL_NO_BASELINE === "1") return { predicted: "[BASELINE_SKIPPED]" };
  const fullHistory = instance.sessions
    .map((s) => `--- session ${s.session_id} (${s.timestamp}) ---\n${sessionToTranscript(s.turns)}`)
    .join("\n\n");
  const answer = await naiveLongContextAnswer(instance.question, fullHistory);
  return { predicted: answer };
}

async function main() {
  const dataPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, "..", "..", "data", "official", "longmemeval", "longmemeval_s_normalized.json");
  if (!fs.existsSync(dataPath)) {
    console.error(`No dataset found at ${dataPath}.`);
    console.error("Download LongMemEval and save a subset there — see comment at top of this file.");
    process.exit(1);
  }

  console.log("Provisioning HydraDB database...");
  await ensureDatabaseReady();
  await checkOllama();

  const allInstances: EvalInstance[] = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  const limit = Number(process.env.EVAL_LIMIT ?? 0);
  const offset = Math.max(0, Number(process.env.EVAL_OFFSET ?? 0));
  const instances = limit > 0 ? allInstances.slice(offset, offset + limit) : allInstances.slice(offset);
  console.log(`Running ${instances.length} of ${allInstances.length} LongMemEval questions.`);

  const results: Record<string, { ours: number; naive: number; total: number }> = {};
  const diagnostics: unknown[] = [];

  for (const instance of instances) {
    const type = instance.question_type ?? "unknown";
    results[type] ??= { ours: 0, naive: 0, total: 0 };
    results[type].total += 1;

    const isAbstentionCase = /abstain|unanswerable/i.test(type) || !instance.answer;

    // Keep HydraDB ingestion/query traffic serial across benchmark instances;
    // the service has a per-second request budget and parallel instances can
    // turn a transient network error into a failed whole run.
    let ours: any;
    let naive: any;
    try {
      ours = await runOurSystem(instance);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${type}] ${instance.question_id}: system error: ${message}`);
      ours = { predicted: "[SYSTEM_ERROR]", verdict: "error", factCount: 0, reason: message };
    }
    try {
      naive = await runNaiveBaseline(instance);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${type}] ${instance.question_id}: baseline error: ${message}`);
      naive = { predicted: "[BASELINE_ERROR]" };
    }

    const oursCorrect = isAbstentionCase
      ? ours.verdict === "abstain"
      : roughMatch(ours.predicted, instance.answer);
    const naiveCorrect = isAbstentionCase
      ? /don't know|not (mentioned|in the|available)|no information/i.test(naive.predicted)
      : roughMatch(naive.predicted, instance.answer);

    if (oursCorrect) results[type].ours += 1;
    if (naiveCorrect) results[type].naive += 1;

    diagnostics.push({
      question_id: instance.question_id,
      question_type: type,
      question: instance.question,
      gold_answer: instance.answer,
      ours: { predicted: ours.predicted, verdict: ours.verdict, fact_count: ours.factCount, reason: ours.reason, correct: oursCorrect },
      naive: { predicted: naive.predicted, correct: naiveCorrect },
    });

    console.log(`[${type}] ${instance.question_id}: ours=${oursCorrect ? "✓" : "✗"} naive=${naiveCorrect ? "✓" : "✗"}`);
  }

  console.log("\n=== Accuracy by question type (our system vs naive long-context baseline) ===");
  console.table(
    Object.entries(results).map(([type, r]) => ({
      question_type: type,
      ours: `${((r.ours / r.total) * 100).toFixed(0)}%`,
      naive_baseline: `${((r.naive / r.total) * 100).toFixed(0)}%`,
      n: r.total,
    }))
  );
  const diagnosticsPath = path.join(process.cwd(), "data", "eval-results.json");
  fs.writeFileSync(diagnosticsPath, JSON.stringify(diagnostics, null, 2));
  console.log(`Detailed diagnostics written to ${diagnosticsPath}`);
}

main();
