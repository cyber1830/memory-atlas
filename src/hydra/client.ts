import { HydraDBClient } from "@hydradb/sdk";
import { RetrievedFact } from "../types";

/**
 * One database ("tenant" in HydraDB's v1 naming) for the whole app.
 * Each end user gets their own collection ("sub-tenant") inside it, so
 * one user's memory never leaks into another's queries. Override via env
 * if you want per-environment databases (dev/staging/prod).
 */
export const DATABASE = process.env.HYDRA_DATABASE ?? "memory-layer";

export const hydra = new HydraDBClient({
  token: process.env.HYDRA_DB_API_KEY,
});

/**
 * Create the database if it doesn't exist yet, then poll until HydraDB
 * reports it ready. Database creation is asynchronous — ingesting or
 * querying before readyForIngestion is true will fail, so every server
 * boot calls this once before accepting traffic (see src/index.ts).
 */
export async function ensureDatabaseReady(
  database: string = DATABASE,
): Promise<void> {
  try {
    await hydra.databases.create({ database });
  } catch {}

  for (let attempt = 0; attempt < 30; attempt++) {
    const status = await hydra.databases.status({ database });
    if (status.data?.infra?.readyForIngestion) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `HydraDB database "${database}" did not become ready in time`,
  );
}

/**
 * Ingest one chat session as a memory. `infer: true` lets HydraDB extract
 * facts and graph relations itself (entity resolution + temporal tracking
 * included); `upsert: true` is what gives us supersession — when a later
 * session states a fact that contradicts an earlier one, HydraDB's own
 * entity resolution reconciles them rather than us hand-rolling a
 * subject+predicate lookup.
 *
 * collection = userId, so each user's memory graph stays isolated.
 */
export async function ingestSessionMemory(params: {
  userId: string;
  sessionId: string;
  timestamp: string;
  transcript: string;
}) {
  const memory = {
    text: params.transcript,
    infer: true,
    additional_metadata: {
      session_id: params.sessionId,
      timestamp: params.timestamp,
    },
  };

  return hydra.context.ingest({
    database: DATABASE,
    collection: params.userId,
    type: "memory",
    memories: JSON.stringify([memory]),
    upsert: "true",
  });
}

export async function waitForIngestion(params: {
  userId: string;
  sourceIds: string[];
  timeoutMs?: number;
}): Promise<string[]> {
  const deadline = Date.now() + (params.timeoutMs ?? 90000);
  let statuses: string[] = [];
  while (Date.now() < deadline) {
    const result = await hydra.context.status({
      database: DATABASE,
      collection: params.userId,
      ids: params.sourceIds,
    });
    statuses = (result.data?.statuses ?? []).map(
      (item: any) => item.indexingStatus ?? item.indexing_status ?? "unknown",
    );
    if (
      statuses.length === params.sourceIds.length &&
      statuses.every((status) =>
        ["completed", "errored", "failed"].includes(status),
      )
    ) {
      return statuses;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `Timed out waiting for HydraDB indexing (last statuses: ${statuses.join(", ") || "unknown"})`,
  );
}

/**
 * Hybrid retrieval over one user's memory, with graph context enriched
 * in. This IS the hybrid vector+graph retrieval step — HydraDB dispatches
 * across corpus/queryBy/mode internally rather than us stitching a vector
 * shortlist and a separate graph traversal together by hand.
 */
export async function recallMemory(params: {
  userId: string;
  question: string;
}) {
  return hydra.query({
    query: params.question,
    database: DATABASE,
    collection: params.userId,
    type: "memory",
    queryBy: "hybrid",
    mode: "thinking",
    graphContext: true,
    maxResults: 10,
  });
}

/**
 * Flattens a query() response's graphContext (query-relevant paths) plus
 * chunk-attached relations into our RetrievedFact shape. Falls back to
 * an explicit context.relations lookup when graphContext comes back
 * empty (e.g. a very sparse graph for a brand-new user) so retrieval
 * still has something to reason over.
 */
/**
 * SearchPathTriplet's source/target/relation fields are typed as
 * Record<string, unknown> in the SDK (opaque passthrough, not run
 * through its camelCase serializer) — so unlike the rest of the SDK,
 * these arrive in the API's raw snake_case wire format. Read both
 * spellings defensively rather than assuming one.
 */
function pick(
  obj: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val) return val;
  }
  return undefined;
}

export function flattenGraphContext(
  queryResult: Awaited<ReturnType<typeof recallMemory>>["data"],
): { facts: RetrievedFact[]; maxChunkScore: number } {
  const facts: RetrievedFact[] = [];
  const maxChunkScore = Math.max(
    0,
    ...(queryResult?.chunks ?? []).map((c) => c.relevancyScore ?? 0),
  );

  const paths = queryResult?.graphContext?.queryPaths?.length
    ? queryResult.graphContext.queryPaths
    : (queryResult?.graphContext?.chunkRelations ?? []);
  for (const path of paths) {
    for (const triplet of path.triplets ?? []) {
      const source = triplet.source as Record<string, unknown> | undefined;
      const target = triplet.target as Record<string, unknown> | undefined;
      const relation = triplet.relation as Record<string, unknown> | undefined;

      facts.push({
        sourceEntity:
          pick(source, "name", "entity_id", "entityId") ?? "unknown",
        targetEntity:
          pick(target, "name", "entity_id", "entityId") ?? "unknown",
        predicate:
          pick(
            relation,
            "canonical_predicate",
            "canonicalPredicate",
            "raw_predicate",
            "rawPredicate",
          ) ?? "related_to",
        timestamp: pick(relation, "timestamp"),
        temporalDetails: pick(relation, "temporal_details", "temporalDetails"),
        confidence:
          relation && typeof relation["confidence"] === "number"
            ? (relation["confidence"] as number)
            : undefined,
        evidenceText: pick(relation, "context"),
        relevance: path.relevancyScore ?? maxChunkScore ?? 0.5,
      });
    }
  }

  // Keep the highest-ranked raw chunks alongside graph relations. Some
  // precise details (names, titles, stores) may be present in the chunk but
  // not promoted into a relation context.
  const topChunks = (queryResult?.chunks ?? [])
    .slice()
    .sort((a, b) => (b.relevancyScore ?? 0) - (a.relevancyScore ?? 0))
    .slice(0, 15);
  for (const chunk of topChunks) {
    const raw = chunk as any;
    const text = raw.chunkContent ?? raw.text ?? raw.content;
    if (typeof text === "string" && text.trim()) {
      facts.push({
        sourceEntity: "retrieved memory",
        targetEntity: text,
        predicate: "contains",
        evidenceText: text,
        sessionId: raw.additionalMetadata?.session_id ?? raw.additional_metadata?.session_id,
        timestamp: raw.additionalMetadata?.timestamp ?? raw.additional_metadata?.timestamp,
        relevance: raw.relevancyScore ?? 0,
      });
    }
  }

  // Sparse/new graphs can return a relevant chunk without a graph path yet.
  // Preserve that evidence instead of converting a real retrieval hit into
  // an empty fact set and an unnecessary abstention.
  if (facts.length === 0) {
    for (const chunk of queryResult?.chunks ?? []) {
      const raw = chunk as any;
      const text =
        raw.text ??
        raw.content ??
        raw.chunkContent ??
        raw.memory ??
        raw.document ??
        raw.chunk;
      if (typeof text !== "string" || !text.trim()) continue;
      facts.push({
        sourceEntity: "retrieved memory",
        targetEntity: text.slice(0, 500),
        predicate: "supports",
        evidenceText: text,
        sessionId:
          raw.additionalMetadata?.session_id ??
          raw.additional_metadata?.session_id,
        timestamp:
          raw.additionalMetadata?.timestamp ??
          raw.additional_metadata?.timestamp,
        relevance: raw.relevancyScore ?? raw.score ?? 0,
      });
    }
  }

  return { facts, maxChunkScore };
}

/**
 * Direct graph relations lookup for one user's whole memory (no query
 * text) — used to power the demo's live graph view and for "what did I
 * say before that" style questions where you want the full relation
 * history, not just what's relevant to one query.
 */
export async function fetchAllRelations(userId: string) {
  return hydra.context.relations({
    database: DATABASE,
    collection: userId,
    type: "memory",
    limit: 200,
  });
}
