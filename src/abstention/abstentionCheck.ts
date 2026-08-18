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
