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
