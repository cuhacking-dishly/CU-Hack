"""The one safe orchestration path for exact and closest recipe search."""

import math
import re
from collections import Counter
from pathlib import Path

from .config import Settings
from .corpus import build_recipe_document, corpus_checksum
from .dataset import load_recipes
from .embeddings import EmbeddingIndex, EmbeddingServiceError, OllamaEmbeddingClient
from .filters import filter_eligible_recipes, filter_exact_candidates
from .models import Recipe, SearchRequest, SearchResponse
from .ranking import rank_recipes

NO_MATCH_MESSAGE = "You cooked too hard! No available recipes match your request."
TOKEN_PATTERN = re.compile(r"[a-z0-9]+")
STOP_WORDS = {
    "a", "an", "and", "around", "for", "i", "in", "me", "my", "no", "of",
    "on", "or", "something", "the", "to", "under", "want", "with", "without",
}


class RetrievalEngine:
    """Load one corpus and enforce filter -> candidate -> rank -> page ordering."""

    def __init__(
        self,
        recipes: list[Recipe],
        *,
        embedder: OllamaEmbeddingClient | None = None,
        index: EmbeddingIndex | None = None,
        index_path: Path | None = None,
        auto_build_index: bool = False,
    ) -> None:
        self.recipes = tuple(recipes)
        self.recipes_by_id = {recipe.id: recipe for recipe in recipes}
        if len(self.recipes_by_id) != len(recipes):
            raise ValueError("recipe ids must be unique")
        self.embedder = embedder
        self.index = index
        self.index_path = index_path
        self.auto_build_index = auto_build_index

    @classmethod
    def from_settings(cls, settings: Settings) -> "RetrievalEngine":
        """Create an engine from the approved corpus and optional local index."""

        recipes = load_recipes(settings.data_path)
        embedder = OllamaEmbeddingClient(
            host=settings.ollama_host,
            model=settings.ollama_model,
            expected_dimension=settings.ollama_expected_dimension,
            connect_timeout_seconds=settings.ollama_connect_timeout_seconds,
            read_timeout_seconds=settings.ollama_read_timeout_seconds,
            batch_size=settings.embedding_batch_size,
        )
        try:
            index = EmbeddingIndex.load(settings.index_path)
        except EmbeddingServiceError:
            index = None
        return cls(
            recipes,
            embedder=embedder,
            index=index,
            index_path=settings.index_path,
            auto_build_index=settings.auto_build_index,
        )

    def close(self) -> None:
        """Release any local Ollama HTTP resources."""

        if self.embedder is not None:
            self.embedder.close()

    def get_recipe(self, recipe_id: str) -> Recipe | None:
        """Return a reviewed recipe by canonical local ID."""

        return self.recipes_by_id.get(recipe_id)

    def build_index(self) -> EmbeddingIndex:
        """Build and atomically persist the complete current semantic index."""

        if self.embedder is None or self.index_path is None:
            raise EmbeddingServiceError(
                "Ollama embedding configuration is unavailable.",
                code="OLLAMA_NOT_CONFIGURED",
            )
        index = EmbeddingIndex.build(self.recipes, self.embedder)
        index.save(self.index_path)
        self.index = index
        return index

    def search(self, request: SearchRequest) -> SearchResponse:
        """Search without ever relaxing allergens, excluded ingredients, or vegan."""

        strictly_eligible = filter_eligible_recipes(self.recipes, request)
        if request.match_mode == "exact":
            candidates = filter_exact_candidates(strictly_eligible, request)
            if not candidates:
                return SearchResponse(
                    recipes=(),
                    match_mode="exact",
                    can_show_closest=bool(strictly_eligible),
                    message=NO_MATCH_MESSAGE,
                    total_candidates=0,
                    semantic_provider="none",
                )
        else:
            candidates = strictly_eligible
            if not candidates:
                return SearchResponse(
                    recipes=(),
                    match_mode="closest",
                    can_show_closest=False,
                    message=NO_MATCH_MESSAGE,
                    total_candidates=0,
                    semantic_provider="none",
                )

        semantic_scores, provider = self._semantic_scores(request.semantic_query, candidates)
        ranked = rank_recipes(candidates, request, semantic_scores)

        # Exclusions shrink the ranked list before paging. Adjusting by the
        # number already reviewed preserves the existing offset-based deck.
        effective_offset = max(0, request.offset - len(request.excluded_recipe_ids))
        page = ranked[effective_offset : effective_offset + request.limit]
        return SearchResponse(
            recipes=tuple(page),
            match_mode=request.match_mode,
            can_show_closest=False,
            message=None,
            total_candidates=len(ranked),
            semantic_provider=provider,
        )

    def _semantic_scores(
        self,
        query: str,
        candidates: list[Recipe],
    ) -> tuple[dict[str, float], str]:
        """Prefer a compatible Ollama index; degrade explicitly to lexical similarity."""

        if self.embedder is not None:
            try:
                digest = self.embedder.model_digest()
                compatible = self.index is not None and self.index.is_compatible(
                    self.recipes,
                    model=self.embedder.model,
                    model_digest=digest,
                    expected_dimension=self.embedder.expected_dimension,
                )
                if not compatible and self.auto_build_index:
                    self.build_index()
                    compatible = True
                if compatible and self.index is not None:
                    query_vector = self.embedder.embed([query])[0]
                    all_scores = self.index.similarities(query_vector)
                    return (
                        {recipe.id: all_scores[recipe.id] for recipe in candidates},
                        f"ollama:{self.embedder.model}",
                    )
            except EmbeddingServiceError:
                pass

        return (
            {
                recipe.id: lexical_similarity(query, build_recipe_document(recipe))
                for recipe in candidates
            },
            "lexical",
        )

    def readiness(self) -> dict[str, object]:
        """Return corpus, vector index, and Ollama state without exposing secrets."""

        index_valid = False
        ollama_status: dict[str, object] = {
            "state": "not_configured",
            "model": None,
            "message": "Ollama client is not configured.",
        }
        if self.embedder is not None:
            status = self.embedder.status(probe=False)
            ollama_status = {
                "state": status.state,
                "version": status.version,
                "model": status.model,
                "modelDigest": status.model_digest,
                "dimension": status.dimension,
                "message": status.message,
            }
            if status.model_digest and self.index is not None:
                index_valid = self.index.is_compatible(
                    self.recipes,
                    model=self.embedder.model,
                    model_digest=status.model_digest,
                    expected_dimension=self.embedder.expected_dimension,
                )
        return {
            "ok": bool(self.recipes),
            "recipeCount": len(self.recipes),
            "corpusChecksum": corpus_checksum(self.recipes),
            "indexReady": index_valid,
            "ollama": ollama_status,
        }


def lexical_similarity(query: str, document: str) -> float:
    """Cosine similarity over term frequencies for explicit degraded operation."""

    query_terms = Counter(_tokenize(query))
    document_terms = Counter(_tokenize(document))
    if not query_terms or not document_terms:
        return 0.0
    dot_product = sum(
        count * document_terms.get(term, 0)
        for term, count in query_terms.items()
    )
    query_norm = math.sqrt(sum(count * count for count in query_terms.values()))
    document_norm = math.sqrt(sum(count * count for count in document_terms.values()))
    return dot_product / (query_norm * document_norm) if query_norm and document_norm else 0.0


def _tokenize(value: str) -> list[str]:
    return [
        token
        for token in TOKEN_PATTERN.findall(value.lower())
        if token not in STOP_WORDS and len(token) > 1
    ]
