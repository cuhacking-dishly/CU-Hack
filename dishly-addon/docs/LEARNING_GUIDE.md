# Learn the Dishly RAG system from the code

Follow the request through the product in this order. Each lesson asks one useful
question: what promise does this layer make to the next one?

## Lesson 1: model the truth

Read `dishly_retrieval/models.py`. `Recipe` is one immutable, reviewed document;
`SearchRequest` is one normalized user need; `ScoreBreakdown` makes ranking
inspectable. Missing nutrition remains unknown rather than becoming a fake zero.

Run: `python -m unittest tests.test_models_dataset -v`

## Lesson 2: reject bad knowledge

Read `dataset.py` and `allergens.py`. The loader validates IDs, source URLs,
images, numbers, ingredient evidence, allergen declarations, and vegan claims
before returning any recipe.

Practical effect: retrieval quality cannot exceed document quality, so corrupt or
unsafe documents never enter the searchable knowledge base.

Run: `python -m unittest tests.test_filters tests.test_models_dataset -v`

## Lesson 3: ingest exact sources

Read `source_extraction.py`, `source_audit.py`, and `ingestion.py`. Dishly extracts
Schema.org Recipe JSON-LD, verifies actual image bytes and dimensions, and writes
the corpus atomically only if the complete source set passes.

Run: `python -m unittest tests.test_source_extraction tests.test_source_audit_ingestion -v`

## Lesson 4: parse language locally

Read `goal_parser.py`. `OllamaGoalParser` gives `qwen3:4b-instruct` an exact JSON
schema at temperature zero, validates its response, and bounds retries/timeouts.
`apply_explicit_constraints` independently recovers unmistakable safety,
category, and numeric phrases. Unsupported or ungrounded output is discarded.

Practical effect: users can write naturally, while a plainly stated `no peanuts`
cannot disappear because a small local model had a bad parse. The model produces
retrieval instructions—not recipes or factual recipe fields.

Run: `python -m unittest tests.test_goal_parser -v`

## Lesson 5: create searchable meaning

Read `corpus.py` and `embeddings.py`. A stable recipe document and user request
are embedded into the same 768-dimensional space. `EmbeddingIndex` records model
digest, dimension, corpus checksum, recipe IDs, and schema version so stale
vectors cannot be silently paired with changed documents.

Run: `python -m unittest tests.test_embeddings tests.test_taxonomy_corpus -v`

## Lesson 6: filter before similarity

Read `filters.py`. Allergy, ingredient, vegan, and swipe rules run before ranking
and are identical in exact and closest modes. A semantically perfect peanut dish
cannot score past `no peanuts`.

Run: `python -m unittest tests.test_filters -v`

## Lesson 7: rank approximate preferences

Read `ranking.py`. Semantic similarity contributes 60%; structured cuisine,
meal, macro, and time relevance contributes 40%. Cuisine is also a tier above
the weighted score. Missing nutrition earns no bonus and no invented value.

Run: `python -m unittest tests.test_ranking -v`

## Lesson 8: orchestrate exact and closest

Read `retrieval.py`. The engine performs strict eligibility, candidate selection,
semantic scoring, stable ranking, and paging in that order. Closest is a separate
user action, not a hidden weakening of the first request.

Run: `python -m unittest tests.test_retrieval_api.RetrievalTests -v`

## Lesson 9: expose a narrow private API

Read `api.py`, then `backend/src/services/retrievalService.js`. Pydantic rejects
malformed private requests. Express calls the parse/search/detail endpoints and
validates every returned field before it reaches the browser.

Run: `python -m unittest tests.test_retrieval_api.ApiTests -v`, then
`npm.cmd --prefix backend test`

## Lesson 10: preserve session behavior

Read `backend/src/store/memoryStore.js`, `backend/src/routes/recipeRoutes.js`, and
`frontend/src/pages/SwipeDeckPage.jsx`. Every goal receives a version; swipes are
excluded only for that version. Cards stay gone during one search and can return
after a genuinely new goal.

Run: `npm.cmd --prefix frontend test` and `npm.cmd run test:fullstack`

## RAG in one sentence

Dishly retrieves reviewed, source-backed documents and places them into the
decision context before ranking or display; local generation is limited to a
structured interpretation of the request.
