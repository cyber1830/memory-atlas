import assert from "assert";
import { extractiveEvidence } from "../llm/client";
import { RetrievedFact } from "../types";

function fact(text: string, relevance = 1): RetrievedFact {
  return { sourceEntity: "memory", targetEntity: text, predicate: "contains", evidenceText: text, relevance };
}

const cases = [
  ["What degree did I graduate with?", "I graduated with a degree in Business Administration.", "Business Administration"],
  ["How long is my daily commute to work?", "My daily commute takes 45 minutes each way.", "45 minutes each way"],
  ["Where did I redeem a $5 coupon on coffee creamer?", "I redeemed a $5 coupon on coffee creamer at Target.", "Target"],
  ["What play did I attend at the local community theater?", "The play I attended was The Glass Menagerie.", "The Glass Menagerie"],
  ["What is the name of the playlist I created on Spotify?", "I created a Spotify playlist called Summer Vibes.", "Summer Vibes"],
] as const;

for (const [question, evidence, expected] of cases) {
  const answer = extractiveEvidence(question, [fact(evidence)]);
  assert(answer.includes(expected), `${question}\nExpected: ${expected}\nGot: ${answer}`);
}

console.log(`Extractive fallback tests passed: ${cases.length}/${cases.length}`);
