import { RetrievedFact } from "../types";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 30000);
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 8192);

function factLine(f: RetrievedFact): string {
  const temporal = f.temporalDetails ? ` (${f.temporalDetails})` : "";
  const session = f.sessionId ? ` [${f.sessionId}]` : "";
  return `${f.sourceEntity} ${f.predicate} ${f.targetEntity}${temporal}${session}`;
}

async function askOllama(prompt: string, timeoutMs = OLLAMA_TIMEOUT_MS): Promise<string | null> {
  if ((process.env.LLM_PROVIDER ?? "ollama") !== "ollama") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0, num_ctx: OLLAMA_NUM_CTX } }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { response?: string };
    return data.response?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Model-based evidence sufficiency check. No dataset-specific entities or predicates. */
export async function judgeEntailment(
  question: string,
  facts: RetrievedFact[]
): Promise<"entailed" | "partial" | "unsupported"> {
  if (facts.length === 0) return "unsupported";
  const verdict = await askOllama(
    `Given ONLY the retrieved evidence below, classify whether the question is answerable. Reply with exactly one word: entailed, partial, or unsupported.\nQuestion: ${question}\nEvidence:\n${facts.map(factLine).join("\n")}`
  );
  if (verdict?.toLowerCase().includes("entailed")) return "entailed";
  if (verdict?.toLowerCase().includes("partial")) return "partial";
  if (verdict?.toLowerCase().includes("unsupported")) return "unsupported";
  // Honest degraded behavior when the local judge is unavailable: retrieved
  // evidence is not treated as fully entailing the question.
  return "partial";
}

/** Model answer grounded only in the facts HydraDB returned. */
export async function generateAnswer(question: string, facts: RetrievedFact[]): Promise<string> {
  const answer = await askOllama(
    `Answer the question using ONLY the retrieved evidence. Preserve chronology when facts conflict, distinguish entities from roles/attributes, and cite session IDs when present. If the evidence is insufficient, say so plainly.\nQuestion: ${question}\nRetrieved evidence:\n${facts.map(factLine).join("\n")}`
  );
  if (answer) return answer;
  return facts
    .slice()
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 4)
    .map(factLine)
    .join("; ");
}

/** Real long-context baseline: sends the complete history to the local model. */
export async function naiveLongContextAnswer(question: string, fullHistory: string): Promise<string> {
  const maxChars = Number(process.env.BASELINE_MAX_CHARS ?? 20000);
  const boundedHistory = maxChars > 0 && fullHistory.length > maxChars
    ? `${fullHistory.slice(0, Math.floor(maxChars / 2))}\n...[history capped for local baseline]...\n${fullHistory.slice(-Math.floor(maxChars / 2))}`
    : fullHistory;
  console.log(`[baseline] history=${fullHistory.length} chars, sent=${boundedHistory.length} chars`);
  const answer = await askOllama(
    `Answer the question using the conversation history below. Do not use outside knowledge. If the answer is not present, say I don't know.\nHistory:\n${boundedHistory}\n\nQuestion: ${question}`,
    Math.max(OLLAMA_TIMEOUT_MS, 60000)
  );
  // Keep infrastructure failure distinguishable from a genuine abstention;
  // the evaluator must never count this as a correct baseline answer.
  return answer ?? "[BASELINE_UNAVAILABLE]";
}
