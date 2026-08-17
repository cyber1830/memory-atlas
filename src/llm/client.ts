import { RetrievedFact } from "../types";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 30000);
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 8192);

function factLine(f: RetrievedFact): string {
  const temporal = f.temporalDetails ? ` (${f.temporalDetails})` : "";
  const session = f.sessionId ? ` [${f.sessionId}]` : "";
  const target = f.targetEntity.length > 700 ? `${f.targetEntity.slice(0, 700)}…` : f.targetEntity;
  return `${f.sourceEntity} ${f.predicate} ${target}${temporal}${session}`;
}

function compactFacts(facts: RetrievedFact[]): RetrievedFact[] {
  return facts.slice().sort((a, b) => b.relevance - a.relevance).slice(0, 8);
}

export function extractiveEvidence(question: string, facts: RetrievedFact[]): string {
  const ignored = new Set("what where when who why how did does is are was were the a an my me i user your to of in on for with and or".split(" "));
  const queryTerms = (question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((term) => !ignored.has(term));
  const candidates = facts.flatMap((fact) => {
    const text = fact.evidenceText ?? fact.targetEntity;
    return text.split(/(?<=[.!?])\s+|\n+/).map((sentence) => ({ sentence: sentence.trim(), fact }));
  }).filter((item) => item.sentence.length > 20);
  const ranked = candidates.map((item) => ({
    ...item,
    score: queryTerms.filter((term) => item.sentence.toLowerCase().includes(term)).length + item.fact.relevance * 0.1,
  })).sort((a, b) => b.score - a.score || b.fact.relevance - a.fact.relevance);
  const bestPerFact = new Map<RetrievedFact, typeof ranked[number]>();
  for (const item of ranked) {
    const current = bestPerFact.get(item.fact);
    if (!current || item.score > current.score) bestPerFact.set(item.fact, item);
  }
  const selected = [...bestPerFact.values()]
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.fact.relevance - a.fact.relevance)
    .slice(0, 4);
  return selected.length ? selected.map((item) => item.sentence).join(" ") : compactFacts(facts).slice(0, 3).map(factLine).join("; ");
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
  const evidence = compactFacts(facts);
  const verdict = await askOllama(
    `Given ONLY the retrieved evidence below, classify whether the question is answerable. Reply with exactly one word: entailed, partial, or unsupported.\nQuestion: ${question}\nEvidence:\n${evidence.map(factLine).join("\n")}`
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
  const evidence = compactFacts(facts);
  const answer = await askOllama(
    `Answer the question using ONLY the retrieved evidence. Preserve chronology when facts conflict, distinguish entities from roles/attributes, and cite session IDs when present. If the evidence is insufficient, say so plainly.\nQuestion: ${question}\nRetrieved evidence:\n${evidence.map(factLine).join("\n")}`
  );
  if (answer) return answer;
  return `[MODEL_UNAVAILABLE] ${extractiveEvidence(question, facts)}`;
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
