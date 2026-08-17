// A fact as HydraDB represents it: a (source entity) -[predicate]-> (target
// entity) triplet with one or more evidence records. HydraDB does its own
// entity resolution and temporal tracking on ingestion (see
// GraphRelationEvidence.temporalDetails / timestamp in the SDK's own types)
// so we read its graph rather than maintaining a parallel edge model.
export interface RetrievedFact {
  sourceEntity: string;
  targetEntity: string;
  predicate: string; // GraphRelationEvidence.canonicalPredicate
  timestamp?: string; // GraphRelationEvidence.timestamp
  temporalDetails?: string; // free-text temporal context HydraDB extracted, when present
  confidence?: number;
  evidenceText?: string; // GraphRelationEvidence.context — verbatim source passage
  sessionId?: string; // from additionalMetadata on the memory we ingested
  relevance: number; // chunk relevancyScore this triplet was attached to, or 1.0 for a direct relations lookup
}

export type AbstentionVerdict = "answer" | "partial_answer" | "abstain";

export interface AbstentionResult {
  verdict: AbstentionVerdict;
  reason: string;
  signals: {
    retrievalHit: boolean;
    maxChunkScore: number;
    entailment: "entailed" | "partial" | "unsupported";
  };
}

export interface SessionInput {
  sessionId: string;
  timestamp: string; // ISO timestamp
  transcript: string; // raw session text
  userId: string; // maps to a HydraDB collection (sub-tenant) — one per end user
}
