import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { ingestRouter } from "./ingestion/ingestRoute";
import { queryRouter } from "./retrieval/queryRoute";
import { ensureDatabaseReady, DATABASE } from "./hydra/client";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.use(ingestRouter);
app.use(queryRouter);

app.get("/health", (_req, res) => res.json({ ok: true, database: DATABASE }));

const PORT = process.env.PORT ?? 3000;

async function main() {
  console.log(`Provisioning HydraDB database "${DATABASE}"...`);
  await ensureDatabaseReady();
  console.log("HydraDB ready.");

  app.listen(PORT, () => {
    console.log(`memory-layer listening on http://localhost:${PORT}`);
    console.log(`demo UI at http://localhost:${PORT}/index.html`);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
