# Architecture and guarantees

## Local service boundary

```text
React -> Express -> Python/FastAPI -> reviewed corpus
                         |
                         +-> Ollama qwen3:4b-instruct (structured parsing)
                         `-> Ollama embeddinggemma (semantic vectors)
```

React is presentation only. Express owns browser validation, current goals, and
same-goal swipe history. Python owns natural-language parsing, the reviewed
corpus, hard safety filters, embeddings, ranking, and recipe details. Ollama is
reachable only by Python. The normal runtime needs no API key or hosted model.

The language model does not decide recipe safety. Its JSON is constrained by a
Pydantic schema and validated. Deterministic code then recovers explicit negation,
allergy, vegan, cuisine, meal, and common numeric language from the user's exact
text. Express validates the resulting filter again. Finally, retrieval checks
publisher ingredient evidence before any vector can influence ranking.

## Retrieval order

1. `SearchRequest` rejects malformed ranges, paging, IDs, and modes.
2. `filter_eligible_recipes` removes same-goal swipes, non-vegan recipes when
   vegan is requested, declared allergens, ingredient-derived allergens, and
   literal ingredient exclusions.
3. Exact mode requires a matching cuisine group and meal. Closest mode starts
   from the same strictly eligible set without those category gates.
4. The query is compared to the local `embeddinggemma` index. A missing/stale
   index degrades explicitly to lexical similarity rather than fabricating data.
5. `rank_recipes` orders by cuisine tier, then a 60% semantic / 40% structured
   score. Nutrition and time are approximate ranking preferences.
6. Paging happens after deterministic ranking and same-goal exclusions.

## Hard and soft rules

| Rule | Exact | Closest |
| --- | --- | --- |
| Allergy/intolerance | hard | hard |
| Explicit excluded ingredient | hard | hard |
| Vegan when requested | hard | hard |
| Same-goal swiped recipe | hard | hard |
| Cuisine | candidate gate | strongest ranking tier |
| Meal type | candidate gate | ranking preference |
| Calories/macros/time | ranking preference | ranking preference |

## Empty and failure behavior

- Empty exact results say: `You cooked too hard! No available recipes match your request.`
- The closest button appears only when a strictly safe candidate exists.
- Closest never relaxes allergies, ingredient exclusions, vegan, or swipes.
- `/health` reports process liveness. `/ready` requires a valid corpus and the
  configured local parser model; it also reports vector-index/model state.
- Express validates every Python response rather than forwarding it blindly.

## Provenance and limits

Ingestion rejects private/localhost source URLs, bounds redirects and response
sizes, requires Recipe JSON-LD, decodes actual image bytes, and enforces a
high-resolution image threshold. Corpus replacement is atomic and all-or-nothing.
Ingredients, images, titles, nutrition, and publisher identity come from the
exact recipe source.

This is a conservative engineering filter, not a medical guarantee. Publisher
errors, substitutions, product labels, and cross-contact warnings still require
human review for severe allergies.
