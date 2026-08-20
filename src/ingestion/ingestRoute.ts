import { Router } from "express";
import { ingestSessionMemory, waitForIngestion } from "../hydra/client";
import { SessionInput } from "../types";

export const ingestRouter = Router();

/**
 * POST /ingest/session
 * Body: { userId, sessionId, timestamp, transcript }
 *
 * Deliberately thin: HydraDB's own inference (infer: true) does fact
 * extraction and entity resolution, and upsert: true is what resolves
 * supersession when a later session contradicts an earlier one — see
 * src/hydra/client.ts for why that logic isn't reimplemented here.
 */
ingestRouter.post("/ingest/session", async (req, res) => {
  const body = req.body as Partial<SessionInput>;
  if (!body.userId || !body.sessionId || !body.transcript || !body.timestamp) {
    return res
      .status(400)
      .json({
        error: "userId, sessionId, timestamp, and transcript are required",
      });
  }

  try {
    const result = await ingestSessionMemory({
      userId: body.userId,
      sessionId: body.sessionId,
      timestamp: body.timestamp,
      transcript: body.transcript,
    });
    const sourceIds = ((result.data as any)?.results ?? [])
      .map((item: any) => item.id)
      .filter(Boolean);
    const statuses = sourceIds.length
      ? await waitForIngestion({ userId: body.userId, sourceIds })
      : [];
    if (statuses.some((status) => ["errored", "failed"].includes(status))) {
      return res
        .status(502)
        .json({ error: "HydraDB could not index this session", statuses });
    }
    res.json({
      sessionId: body.sessionId,
      indexed: true,
      statuses,
      hydraResponse: result.data,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "ingestion failed" });
  }
});
