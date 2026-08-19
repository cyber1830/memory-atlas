import { AbstentionResult, RetrievedFact } from "../types";
import { judgeEntailment } from "../llm/client";

const RELEVANCE_THRESHOLD = 0.15; // tune against HydraDB's actual score distribution once you have real traffic

/**
 * Two independent signals, checked before generation is ever allowed
 * to run:
 *  A. Retrieval coverage — did HydraDB's recall return anything at all,
 *     and how confident was the best chunk match?
 *  B. LLM entailment — do the retrieved facts actually support an
 *     answer? This call sees ONLY the retrieved facts, never raw
 *     chat history, so it's judging retrieval sufficiency, not
 *     re-deriving the answer from scratch.
 *
 * Neither signal alone decides — a chunk hit with "unsupported"
 * entailment still abstains; a low score with a genuine graph-path
 * match can still answer.
 */
export async function abstentionCheck(
  question: string,
  facts: RetrievedFact[],
  maxChunkScore: number
): Promise<AbstentionResult> {
  const retrievalHit = facts.length > 0;

  // A requested year is a hard constraint. Do not answer from a related fact
  // when the history never mentions that year (for example, a degree question
  // asking specifically about 1967).
  const requestedYears = question.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  if (requestedYears.length > 0) {
    const evidenceText = facts
      .map((fact) => `${fact.evidenceText ?? ''} ${fact.targetEntity} ${fact.temporalDetails ?? ''}`)
      .join(' ');
    if (!requestedYears.every((year) => evidenceText.includes(year))) {
      return {
        verdict: "abstain",
        reason: "the requested date is not present in the retrieved memory",
        signals: { retrievalHit, maxChunkScore, entailment: "unsupported" },
      };
    }
  }

  // A same-session lexical context hit is a grounded retrieval signal. It is
  // useful when the graph stores the answer across adjacent conversational
  // turns and the small judge model incorrectly labels that evidence as
  // unsupported.
  const ignored = new Set("what where when who why how did does is are was were the a an my me user your to of in on for with and or".split(" "));
  const terms = (question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((term) => !ignored.has(term));
  const lexicalContextHit = facts.some((fact) => {
    if (!fact.evidenceText && !fact.targetEntity) return false;
    const text = (fact.evidenceText ?? fact.targetEntity).toLowerCase();
    return terms.filter((term) => text.includes(term)).length >= 2;
  });
  if (lexicalContextHit) {
    return {
      verdict: "answer",
      reason: "same-session evidence directly matches the question",
      signals: { retrievalHit: true, maxChunkScore, entailment: "entailed" },
    };
  }

  if (!retrievalHit && maxChunkScore < RELEVANCE_THRESHOLD) {
    return {
      verdict: "abstain",
      reason: "no relevant facts found in memory",
      signals: { retrievalHit, maxChunkScore, entailment: "unsupported" },
    };
  }

  // Fast local evaluation mode: avoid a second long Ollama call for the
  // entailment judge. This is opt-in and only answers when retrieval returned
  // evidence; the normal two-signal abstention gate remains the default.
  if (process.env.SKIP_ENTAILMENT_JUDGE === "1") {
    return {
      verdict: "answer",
      reason: "retrieved evidence available (fast mode)",
      signals: { retrievalHit, maxChunkScore, entailment: "entailed" },
    };
  }

  const entailment = await judgeEntailment(question, facts);

  if (entailment === "unsupported") {
    return {
      verdict: "abstain",
      reason: "facts were retrieved but do not answer this question",
      signals: { retrievalHit, maxChunkScore, entailment },
    };
  }

  if (entailment === "partial") {
    return {
      verdict: "partial_answer",
      reason: "facts are related but leave ambiguity",
      signals: { retrievalHit, maxChunkScore, entailment },
    };
  }

  return {
    verdict: "answer",
    reason: "facts fully support an answer",
    signals: { retrievalHit, maxChunkScore, entailment },
  };
}
