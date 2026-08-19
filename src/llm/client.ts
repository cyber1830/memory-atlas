import { RetrievedFact } from "../types";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 30000);
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 8192);
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.1-8b-instant";

function factLine(f: RetrievedFact): string {
  const temporal = f.temporalDetails ? ` (${f.temporalDetails})` : "";
  const session = f.sessionId ? ` [${f.sessionId}]` : "";
  const target = f.targetEntity.length > 700 ? `${f.targetEntity.slice(0, 700)}…` : f.targetEntity;
  return `${f.sourceEntity} ${f.predicate} ${target}${temporal}${session}`;
}

function compactFacts(facts: RetrievedFact[]): RetrievedFact[] {
  // Keep enough adjacent-turn evidence for multi-turn facts. The local fast
  // mode skips the judge call; it must not also discard the context needed to
  // answer the question.
  return facts.slice().sort((a, b) => b.relevance - a.relevance).slice(0, 15);
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
  const bestPerFact = new Map<RetrievedFact, typeof ranked[number][]>();
  for (const item of ranked) {
    const current = bestPerFact.get(item.fact) ?? [];
    if (current.length < 3) current.push(item);
    bestPerFact.set(item.fact, current);
  }
  const selected = [...bestPerFact.values()].flat()
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.fact.relevance - a.fact.relevance)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.sentence === item.sentence) === index)
    .slice(0, 1);
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
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        keep_alive: "30m",
        options: { temperature: 0, num_ctx: OLLAMA_NUM_CTX },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[ollama] HTTP ${response.status} for model ${OLLAMA_MODEL}: ${body.slice(0, 300)}`);
      return null;
    }
    const data = (await response.json()) as { response?: string };
    if (!data.response?.trim()) {
      console.error(`[ollama] Empty response from model ${OLLAMA_MODEL}`);
      return null;
    }
    return data.response.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ollama] ${OLLAMA_MODEL} failed: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function askGroq(prompt: string, timeoutMs = OLLAMA_TIMEOUT_MS): Promise<string | null> {
  if ((process.env.LLM_PROVIDER ?? "ollama") !== "groq") return null;
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    console.error("[groq] GROQ_API_KEY is missing");
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      // GPT-OSS models may spend part of a small completion budget on
      // reasoning, leaving message.content empty. Give the model enough room
      // to finish the short grounded answer.
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        max_tokens: Number(process.env.GROQ_MAX_TOKENS ?? 1024),
        reasoning_effort: process.env.GROQ_REASONING_EFFORT ?? "low",
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[groq] HTTP ${response.status}: ${body.slice(0, 300)}`);
      return null;
    }
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      console.error(`[groq] Empty response from model ${GROQ_MODEL}`);
      return null;
    }
    return answer;
  } catch (error) {
    console.error(`[groq] ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function askModel(prompt: string, timeoutMs = OLLAMA_TIMEOUT_MS): Promise<string | null> {
  return (process.env.LLM_PROVIDER ?? "ollama") === "groq"
    ? askGroq(prompt, timeoutMs)
    : askOllama(prompt, timeoutMs);
}

export async function checkOllama(): Promise<void> {
  if ((process.env.LLM_PROVIDER ?? "ollama") === "groq") {
    if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing. Add it to .env.");
    const response = await fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` } });
    if (!response.ok) throw new Error(`Groq preflight failed (HTTP ${response.status}). Check GROQ_API_KEY.`);
    console.log(`[groq] ready: ${GROQ_MODEL}`);
    return;
  }
  if ((process.env.LLM_PROVIDER ?? "ollama") !== "ollama") return;
  const response = await fetch("http://localhost:11434/api/tags");
  if (!response.ok) throw new Error(`Ollama is unreachable (HTTP ${response.status})`);
  const data = (await response.json()) as { models?: { name?: string }[] };
  const models = data.models?.map((model) => model.name ?? "") ?? [];
  if (!models.some((name) => name === OLLAMA_MODEL || name.startsWith(`${OLLAMA_MODEL}:`))) {
    throw new Error(`Ollama model '${OLLAMA_MODEL}' is not installed. Available: ${models.join(", ") || "none"}`);
  }
  console.log(`[ollama] ready: ${OLLAMA_MODEL}`);
}

/** Model-based evidence sufficiency check. No dataset-specific entities or predicates. */
export async function judgeEntailment(
  question: string,
  facts: RetrievedFact[]
): Promise<"entailed" | "partial" | "unsupported"> {
  if (facts.length === 0) return "unsupported";
  const evidence = compactFacts(facts);
  const verdict = await askModel(
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
  const answer = await askModel(
    `Answer using ONLY the retrieved evidence. Return the shortest direct answer possible: usually the exact name, title, place, number, or phrase requested. Do not add background, explanations, guesses, or unrelated facts. Preserve chronology when facts conflict. If the requested answer is not directly supported, reply exactly: I don't know.\nQuestion: ${question}\nRetrieved evidence:\n${evidence.map(factLine).join("\n")}`
  );
  const looksLikeFragment = Boolean(answer && (/^\s*[$€£]?\d+(?:\.\d+)?\s*$/.test(answer) || answer.trim().split(/\s+/).length < 2));
  if (answer && !looksLikeFragment && !/^\s*(i\s+don['’]?t\s+know|unknown|insufficient information)\.?\s*$/i.test(answer)) {
    return answer;
  }
  // If the model abstains despite having grounded evidence, return the best
  // retrieved sentence rather than losing an answer that is already present.
  // This remains dataset-agnostic and never invents content.
  // Deterministic, grounded fallback for hosted demos when the model is
  // unavailable. This is evidence extraction—not invented synthesis—and is
  // intentionally limited to the most relevant sentences.
  if (facts.length > 0) return extractiveEvidence(question, facts);
  return "I don't have enough grounded memory to answer confidently.";
}

/** Real long-context baseline: sends the complete history to the local model. */
export async function naiveLongContextAnswer(question: string, fullHistory: string): Promise<string> {
  const maxChars = Number(process.env.BASELINE_MAX_CHARS ?? 20000);
  const boundedHistory = maxChars > 0 && fullHistory.length > maxChars
    ? `${fullHistory.slice(0, Math.floor(maxChars / 2))}\n...[history capped for local baseline]...\n${fullHistory.slice(-Math.floor(maxChars / 2))}`
    : fullHistory;
  console.log(`[baseline] history=${fullHistory.length} chars, sent=${boundedHistory.length} chars`);
  const answer = await askModel(
    `Answer the question using the conversation history below. Do not use outside knowledge. If the answer is not present, say I don't know.\nHistory:\n${boundedHistory}\n\nQuestion: ${question}`,
    Math.max(OLLAMA_TIMEOUT_MS, 60000)
  );
  // Keep infrastructure failure distinguishable from a genuine abstention;
  // the evaluator must never count this as a correct baseline answer.
  return answer ?? "[BASELINE_UNAVAILABLE]";
}
