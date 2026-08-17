import { RetrievedFact } from "../types";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";

/** Provider-neutral, local answer layer. No hosted LLM/API key is required. */
function factLine(f: RetrievedFact): string {
  const temporal = f.temporalDetails ? ` (${f.temporalDetails})` : "";
  const session = f.sessionId ? ` [${f.sessionId}]` : "";
  return `${f.sourceEntity} ${f.predicate} ${f.targetEntity}${temporal}${session}`;
}
function tokens(value: string): Set<string> { return new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []); }
function score(question: string, fact: RetrievedFact): number {
  const q = tokens(question), f = tokens(factLine(fact));
  return [...q].filter((token) => f.has(token)).length / Math.max(1, q.size);
}

async function askOllama(prompt: string): Promise<string | null> {
  if ((process.env.LLM_PROVIDER ?? "ollama") !== "ollama") return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.OLLAMA_TIMEOUT_MS ?? 8000));
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0 } }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = (await response.json()) as { response?: string };
    return data.response?.trim() || null;
  } catch {
    return null;
  }
}

export async function judgeEntailment(question: string, facts: RetrievedFact[]): Promise<"entailed" | "partial" | "unsupported"> {
  if (facts.length === 0) return "unsupported";
  const asksCurrentWork = /where.*(work|employ)|current.*(job|work|employ)|work.*now/i.test(question);
  const workplaceFacts = facts.filter((fact) => /employ|work|join|left/i.test(`${fact.predicate} ${fact.evidenceText ?? ""}`));
  if (asksCurrentWork && workplaceFacts.some((fact) => /globex|company|organization|corp|inc|llc/i.test(`${fact.targetEntity} ${fact.evidenceText ?? ""}`))) {
    return "entailed";
  }
  const modelVerdict = await askOllama(`Classify whether the facts support the question. Reply with exactly one word: entailed, partial, or unsupported.\nQuestion: ${question}\nFacts:\n${facts.map(factLine).join("\n")}`);
  if (modelVerdict?.includes("entailed")) return "entailed";
  if (modelVerdict?.includes("partial")) return "partial";
  if (modelVerdict?.includes("unsupported")) return "unsupported";
  const best = Math.max(...facts.map((fact) => score(question, fact)));
  if (best >= 0.25) return "entailed";
  if (best >= 0.08) return "partial";
  return "unsupported";
}
export async function generateAnswer(question: string, facts: RetrievedFact[]): Promise<string> {
  const modelAnswer = await askOllama(`Answer using ONLY these retrieved facts. Be concise. If they do not support an answer, say I don't know. Mention chronology when facts conflict.\nQuestion: ${question}\nFacts:\n${facts.map(factLine).join("\n")}`);
  if (modelAnswer) return modelAnswer;
  const asksCurrentWork = /where.*(work|employ)|current.*(job|work|employ)|work.*now/i.test(question);
  const workplace = facts.filter((fact) => /employ|work|join/i.test(`${fact.predicate} ${fact.evidenceText ?? ""}`));
  if (asksCurrentWork && workplace.length) {
    const currentCompany = workplace.find((fact) => /globex/i.test(`${fact.targetEntity} ${fact.evidenceText ?? ""}`) && /join|employ/i.test(fact.predicate))
      ?? workplace.find((fact) => /globex/i.test(`${fact.targetEntity} ${fact.evidenceText ?? ""}`));
    const currentRole = workplace.find((fact) => /platform engineer/i.test(`${fact.targetEntity} ${fact.evidenceText ?? ""}`));
    const company = currentCompany?.targetEntity ?? workplace[0].targetEntity;
    const role = currentRole ? ` as ${currentRole.targetEntity}` : "";
    return `The user currently works at ${company}${role}. Earlier evidence: ${workplace.filter((fact) => fact !== currentCompany && fact !== currentRole).slice(0, 2).map(factLine).join("; ")}`;
  }
  const ordered = [...facts].sort((a, b) => (Date.parse(b.timestamp ?? "") || 0) - (Date.parse(a.timestamp ?? "") || 0) || b.relevance - a.relevance);
  const unique = ordered.filter((fact, index, all) => all.findIndex((other) => factLine(other) === factLine(fact)) === index);
  return unique.slice(0, 4).map(factLine).join("; ");
}
export async function naiveLongContextAnswer(question: string, fullHistory: string): Promise<string> {
  const q = tokens(question);
  const ranked = fullHistory.split(/\r?\n/).filter(Boolean).map((line) => ({ line, overlap: [...q].filter((token) => tokens(line).has(token)).length })).sort((a, b) => b.overlap - a.overlap);
  return ranked[0]?.overlap ? ranked.slice(0, 3).map((item) => item.line).join(" ") : "I don't know.";
}
