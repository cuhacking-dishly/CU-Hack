# Dishly hybrid recipe retrieval

This folder is Dishly's private local RAG service. Ollama turns a natural-language goal into structured preferences; deterministic code preserves explicit safety constraints; retrieval then applies non-negotiable gates, searches a reviewed local corpus, combines semantic and structured relevance, and returns traceable publisher recipes to Express.

It is a retrieval-augmented system, not a recipe-generating system. The model never invents a recipe, ingredient list, nutrition value, source, or image.

## Pipeline

```text
natural-language goal
  -> local qwen3:4b-instruct parses a validated goal filter
  -> deterministic overlay recovers explicit constraints
  -> hard eligibility: allergy + excluded ingredient + vegan + same-goal swipes
  -> exact cuisine/meal candidate selection
  -> Ollama embedding similarity + structured scoring
  -> most relevant 10 reviewed recipes
  -> clearly labelled closest mode only when exact mode is empty
```

Closest mode relaxes cuisine, meal, and approximate nutrition preferences. It never relaxes allergies, explicit ingredient exclusions, vegan, or same-goal swipe exclusions.

## One-command setup from the repository root

Prerequisites are Python 3.11+, Node.js 24+, npm 11+, and [Ollama for Windows](https://ollama.com/download/windows). Then run:

```powershell
npm.cmd ci
npm.cmd run setup
```

The setup script creates `dishly-addon/.venv`, installs the pinned dependencies, installs backend/frontend packages, starts Ollama if necessary, pulls `qwen3:4b-instruct` and `embeddinggemma`, validates the corpus, and builds the local vector index. The index is generated and intentionally not committed.

To start Python, Express, and React together:

```powershell
npm.cmd run dev
```

The private service listens on `http://127.0.0.1:8000`. Express is the public application boundary; the browser never calls this service directly.

## Direct commands

Run these inside `dishly-addon`:

```powershell
.\.venv\Scripts\python.exe -m dishly_retrieval validate
.\.venv\Scripts\python.exe -m dishly_retrieval status
.\.venv\Scripts\python.exe -m dishly_retrieval build-index
.\.venv\Scripts\python.exe -m dishly_retrieval search "Asian dinner with 50g protein and no peanuts" --cuisine asian --allergen peanut
.\.venv\Scripts\python.exe -m dishly_retrieval serve
```

To rebuild the corpus from exact publisher pages, use `ingest`. This performs network and image checks and replaces `recipes.json` only if every source passes:

```powershell
.\.venv\Scripts\python.exe -m dishly_retrieval ingest
```

## Folder map

```text
data/
  source_seeds.json          reviewed source URLs and classifications
  source_audit_report.json   last all-source audit result
  recipes.json               approved serving corpus
  recipes.schema.json        machine-readable record shape
  embeddings.json            generated Ollama vectors (gitignored)
dishly_retrieval/
  allergens.py               ingredient/allergen/vegan evidence
  goal_parser.py             local parsing and explicit-constraint overlay
  dataset.py                 fail-closed corpus validation
  source_*.py, ingestion.py  safe publisher extraction and image audit
  corpus.py, embeddings.py   embedding documents and Ollama index
  filters.py, ranking.py     hard gates and explainable ranking
  retrieval.py               exact/closest orchestration
  api.py, cli.py             private HTTP and operator commands
tests/                       deterministic unit and contract tests
```

## Configuration

All settings are optional and have local defaults. See `.env.example`. The service reads environment variables directly; it does not load `.env` itself. Notable values are `OLLAMA_HOST`, `OLLAMA_EMBEDDING_MODEL`, `OLLAMA_PARSER_MODEL`, `DISHLY_DATA_PATH`, `DISHLY_INDEX_PATH`, and `DISHLY_AUTO_BUILD_INDEX`. The older `OLLAMA_MODEL` name remains a compatibility fallback for embeddings.

`embeddinggemma` is 768-dimensional. A vector cache is invalidated when the corpus checksum, model name, model digest, dimension, or index schema changes.

`DISHLY_SERVICE_TOKEN` optionally protects every route except `/health` with a
constant-time bearer-token check. Leave it unset only for loopback/private local
development. Any cross-host deployment must set a random 32+ character value and
configure the same value as Express `RETRIEVAL_SERVICE_TOKEN`.

## Verification

From the repository root, `npm.cmd run test:python` runs Ruff, all Python tests, branch coverage with a 90% gate, and real-corpus validation. `npm.cmd run verify` additionally runs backend, frontend, build, and browser suites.

For a code-first explanation, read [the learning guide](docs/LEARNING_GUIDE.md). Architecture and operational guarantees are in [ARCHITECTURE.md](docs/ARCHITECTURE.md), and source curation is in [DATA_CURATION.md](docs/DATA_CURATION.md).
The complete cloud topology is documented in
[`../docs/PRODUCTION_DEPLOYMENT.md`](../docs/PRODUCTION_DEPLOYMENT.md).

## Official Ollama references

- [Embeddings capability](https://docs.ollama.com/capabilities/embeddings)
- [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs)
- [Chat API](https://docs.ollama.com/api/chat)
- [`POST /api/embed`](https://docs.ollama.com/api/embed)
- [`embeddinggemma` model](https://ollama.com/library/embeddinggemma)
- [`qwen3:4b-instruct` model](https://ollama.com/library/qwen3:4b-instruct)
- [Windows installation](https://docs.ollama.com/windows)
