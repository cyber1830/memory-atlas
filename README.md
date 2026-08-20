# memory-layer

A graph-native agent memory layer for cross-session continuity, built on
**HydraDB** for the [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
/ BEAM hackathon track ("Hack Hydra").

## Why this shape

Most memory systems flatten chat history into vector-searchable facts. That
loses two things LongMemEval specifically tests: **temporal supersession**
(fact A was true, then overwritten by fact B) and honest **abstention**
(recognizing the answer isn't in memory at all instead of inventing one).

Rather than re-implementing entity resolution and temporal tracking on top
of a generic vector store, this project uses HydraDB's own graph-native
primitives for that layer, and builds the parts HydraDB doesn't do for you
on top:

- **Ingestion** — `client.context.ingest(..., type: "memory", infer: true, upsert: "true")`.
  `infer: true` has HydraDB extract facts and resolve entities itself;
  `upsert: true` is what gives us supersession — a later session that
  contradicts an earlier one gets reconciled by HydraDB's entity
  resolution, not a hand-rolled subject+predicate lookup.
- **Retrieval** — `client.query({ queryBy: "hybrid", graphContext: true })`.
  HydraDB dispatches across vector + graph internally and returns scored
  relation paths (`graphContext.queryPaths`), each carrying a
  `canonical_predicate`, `timestamp`, and `temporal_details` per the SDK's
  `GraphRelationEvidence` type — this is the hybrid retrieval + temporal
  ordering the problem statement asks for, read directly from HydraDB
  rather than stitched together by hand.
- **Abstention** — _not_ something HydraDB decides for you. This project's
  actual contribution is the two-signal gate in
  `src/abstention/abstentionCheck.ts`: did retrieval return anything above
  a relevance threshold, **and** does an LLM judge — shown only the
  retrieved facts, never raw history — think they're sufficient. Both
  signals are returned with every response as inspectable evidence.

## Architecture

```
Chat sessions (1..N)
      |
      v
POST /ingest/session
      |
      v
client.context.ingest (HydraDB: extraction + entity resolution + upsert)
      |
      v            (at query time)
POST /query
      |
      v
client.query (HydraDB: hybrid vector + graph retrieval, graph_context: true)
      |
      v
Abstention gate (retrieval-hit signal + LLM entailment signal — ours)
      |
      v
Answer generation (sees only retrieved facts + session provenance — ours)
```

## Quick start

```bash
cp .env.example .env
# add HYDRA_DB_API_KEY; Ollama is used locally when available
npm install
npm run dev             # http://localhost:3000/index.html
```

On boot the server creates the HydraDB database (if it doesn't already
exist) and polls `client.databases.status` until `readyForIngestion` is
true — database provisioning is asynchronous, so don't skip this step if
you're calling the API directly instead of through this server.

Or with Docker:

```bash
cp .env.example .env
docker compose up --build
```

HydraDB itself runs as the hosted service at `https://api.hydradb.com` via
`HYDRA_DB_API_KEY` — nothing to stand up locally for it. If you're building
against the open-sourced HydraDB repo directly instead of the hosted API,
see the comment in `docker-compose.yml` for where to add that service.

## API

- `POST /ingest/session` — `{ userId, sessionId, timestamp, transcript }` →
  ingests as a HydraDB memory (`infer: true, upsert: true`), scoped to that
  user's collection.
- `POST /query` — `{ userId, question }` → HydraDB hybrid recall → flatten
  graph context to facts → abstention gate → answer (or a structured
  abstain response with both signals attached).
- `GET /graph?userId=...` — full relation dump for that user, via
  `client.context.relations`, used by the demo UI's live graph view.

## Running the eval

```bash
# Download LongMemEval and save a subset (10-20 instances covering each
# question_type) to data/longmemeval_subset.json — a 2-instance example
# ships in this repo so the harness runs out of the box.
npm run eval
```

Each eval instance gets its own HydraDB collection (`eval-<question_id>`)
so runs are isolated and repeatable. Prints per-question-type accuracy for
this system **and** a naive long-context baseline (dump full history into
one prompt, ask directly, bypassing HydraDB) side by side — this is the
table that demonstrates the accuracy gap the problem statement describes,
with your own numbers instead of a citation.

## Demo script (3 minutes)

1. Ingest 2-3 short synthetic sessions live, including one that changes a
   previously-stated fact (job change, moved cities, changed a preference).
2. Ask a question that requires the _current_ value — show the answer
   citing the session it came from.

### Render deployment

1. Create a new Web Service from this repository on Render.
2. Render will use `render.yaml`; add `HYDRA_DB_API_KEY` and `GROQ_API_KEY` as
   secret environment variables.
3. Keep `LLM_PROVIDER=groq` for the hosted demo. Local Ollama is only for
   offline development because a Render service cannot access your laptop's
   Ollama process.
4. Open `/index.html` after the health check becomes live.

The demo's differentiator is **fact evolution**: an older relationship stays
visible in the evidence trail while the newer relationship becomes current.
This makes supersession inspectable instead of hiding it behind a single
vector-search result. 3. Show the live graph view (`GET /graph`) and point at the relation's
`temporal_details` / `timestamp` fields as HydraDB's own record of when
that fact was true — this is the "git-style temporal versioning" the
graph gives you natively. 4. Ask something never mentioned — show the system abstain, and point at
the two signals (`retrievalHit`, `entailment`) in the response as the
evidence trail, not just a refusal. 5. Show the eval table: your system vs. the naive long-context baseline on
the abstention category specifically.

## What's simplified for hackathon time (documented, not hidden)

- **Eval scoring** is a rough substring match against the gold answer,
  good enough for a directional accuracy table — swap in LongMemEval's
  official scorer for a rigorous final number.
- **Ingestion readiness** in the eval harness is a flat `sleep(4000)`
  rather than polling `client.context.status` per source — fine for a
  handful of eval instances, swap to real polling before scaling up.
- The SDK surface used here (`@hydradb/sdk@2.1.2`, the `database` /
  `collection` v2 naming) was verified against the package's own compiled
  type definitions at the time this was built. HydraDB is actively being
  open-sourced during Hack Hydra (Aug 12–20, 2026) — double check
  `node_modules/@hydradb/sdk/README.md` and the current
  [docs](https://docs.hydradb.com) for anything that's moved since.
- One database is shared across all users (`HYDRA_DATABASE` env var),
  with per-user isolation via collections (`userId`). Revisit if your
  demo needs stronger tenant isolation than that.

## License

MIT

## Attribution

- [HydraDB](https://github.com/hydradatabase/hydradb) and `@hydradb/sdk` power
  graph-native ingestion, entity resolution, temporal relationships, and
  hybrid retrieval.
- [LongMemEval](https://github.com/xiaowu0162/LongMemEval) and
  [BEAM](https://github.com/mohammadtavakoli78/BEAM) provide the benchmark
  formats and evaluation conversations used by the adapters in `src/eval/`.
- The hosted demo uses Groq-compatible OpenAI-style inference; local
  development can use Ollama. API keys are supplied through environment
  variables and are never committed.
