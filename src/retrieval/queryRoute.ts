import { Router } from "express";
import {
  recallMemory,
  flattenGraphContext,
  fetchAllRelations,
} from "../hydra/client";
import { abstentionCheck } from "../abstention/abstentionCheck";
import { generateAnswer } from "../llm/client";

export const queryRouter = Router();

/**
 * POST /query
 * Body: { userId, question }
 *
 * Pipeline: HydraDB hybrid recall (vector + graph, native) -> flatten to
 * facts -> abstention gate -> (maybe) generate. The abstention verdict
 * and both underlying signals are always returned, even on a successful
 * answer — that's what you show judges as inspectable evidence instead
 * of "trust the LLM".
 */
queryRouter.post("/query", async (req, res) => {
  const { userId, question } = req.body ?? {};
  if (!userId || !question)
    return res.status(400).json({ error: "userId and question are required" });

  try {
    const recallResult = await recallMemory({ userId, question });
    const { facts, maxChunkScore } = flattenGraphContext(recallResult.data);
    const abstention = await abstentionCheck(question, facts, maxChunkScore);

    if (abstention.verdict === "abstain") {
      return res.json({
        question,
        answer: null,
        verdict: abstention.verdict,
        reason: abstention.reason,
        signals: abstention.signals,
        retrievedFacts: facts,
      });
    }

    const answer = await generateAnswer(question, facts);
    res.json({
      question,
      answer,
      verdict: abstention.verdict,
      reason: abstention.reason,
      signals: abstention.signals,
      retrievedFacts: facts,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "query failed" });
  }
});

/** GET /graph?userId=... — full relation dump for the demo visualization. */
queryRouter.get("/graph", async (req, res) => {
  const userId = req.query.userId as string | undefined;
  if (!userId)
    return res.status(400).json({ error: "userId query param is required" });

  try {
    const result = await fetchAllRelations(userId);
    const triplets = result.data?.relations ?? [];

    const nodeNames = new Set<string>();
    triplets.forEach((t) => {
      if (t.source?.name) nodeNames.add(t.source.name);
      if (t.target?.name) nodeNames.add(t.target.name);
    });

    const edges = triplets.flatMap((t) =>
      (t.relations ?? []).map((evidence) => ({
        id: evidence.relationshipId,
        from: t.source?.name ?? t.source?.entityId,
        to: t.target?.name ?? t.target?.entityId,
        label: evidence.canonicalPredicate ?? evidence.rawPredicate,
        timestamp: evidence.timestamp,
        temporalDetails: evidence.temporalDetails,
      })),
    );

    res.json({
      nodes: Array.from(nodeNames).map((id) => ({ id, label: id })),
      edges,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "graph fetch failed" });
  }
});

queryRouter.get("/stats", async (req, res) => {
  const userId = req.query.userId as string | undefined;
  if (!userId)
    return res.status(400).json({ error: "userId query param is required" });
  try {
    const result = await fetchAllRelations(userId);
    const triplets = result.data?.relations ?? [];
    const entities = new Set<string>();
    let relationships = 0;
    for (const item of triplets) {
      if (item.source?.name) entities.add(item.source.name);
      if (item.target?.name) entities.add(item.target.name);
      relationships += (item.relations ?? []).length;
    }
    res.json({ entities: entities.size, relationships, connected: true });
  } catch (err: any) {
    res
      .status(502)
      .json({ connected: false, error: err.message ?? "stats unavailable" });
  }
});
