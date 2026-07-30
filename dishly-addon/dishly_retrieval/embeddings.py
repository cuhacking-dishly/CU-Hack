"""Ollama embeddings and a digest-aware, atomic local vector cache."""

import json
import math
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import ollama

from .corpus import build_recipe_document, corpus_checksum
from .models import Recipe

INDEX_SCHEMA_VERSION = 1
MIN_EMBEDDINGGEMMA_VERSION = (0, 11, 10)
RETRYABLE_STATUS_CODES = {429, 500, 502, 503}


class EmbeddingServiceError(RuntimeError):
    """A stable, actionable Ollama or vector-integrity failure."""

    def __init__(self, message: str, *, code: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class OllamaStatus:
    """Four-stage status used by readiness and setup diagnostics."""

    state: str
    version: str | None
    model: str
    model_digest: str | None
    dimension: int | None
    message: str


@dataclass(frozen=True, slots=True)
class EmbeddingIndex:
    """Validated recipe vectors tied to one corpus and exact model digest."""

    model: str
    model_digest: str
    dimension: int
    corpus_checksum: str
    recipe_ids: tuple[str, ...]
    vectors: np.ndarray

    @classmethod
    def build(
        cls,
        recipes: list[Recipe] | tuple[Recipe, ...],
        client: "OllamaEmbeddingClient",
    ) -> "EmbeddingIndex":
        """Embed the complete corpus; never retain a partial index."""

        model_digest = client.model_digest()
        texts = [build_recipe_document(recipe) for recipe in recipes]
        vectors = np.asarray(client.embed(texts), dtype=np.float32)
        _validate_matrix(vectors, len(recipes), client.expected_dimension)
        return cls(
            model=client.model,
            model_digest=model_digest,
            dimension=vectors.shape[1],
            corpus_checksum=corpus_checksum(recipes),
            recipe_ids=tuple(recipe.id for recipe in recipes),
            vectors=vectors,
        )

    @classmethod
    def load(cls, path: Path) -> "EmbeddingIndex":
        """Load and validate a cache file before it can influence ranking."""

        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise EmbeddingServiceError(
                f"Embedding index was not found: {path}",
                code="INDEX_NOT_FOUND",
            ) from error
        except json.JSONDecodeError as error:
            raise EmbeddingServiceError(
                "Embedding index is not valid JSON.",
                code="INDEX_INVALID",
            ) from error

        try:
            if document["schema_version"] != INDEX_SCHEMA_VERSION:
                raise ValueError("unsupported schema version")
            model = str(document["model"])
            model_digest = str(document["model_digest"])
            dimension = int(document["dimension"])
            checksum = str(document["corpus_checksum"])
            recipe_ids = tuple(str(value) for value in document["recipe_ids"])
            vectors = np.asarray(document["vectors"], dtype=np.float32)
            _validate_matrix(vectors, len(recipe_ids), dimension)
            if len(set(recipe_ids)) != len(recipe_ids):
                raise ValueError("duplicate recipe ids")
        except (KeyError, TypeError, ValueError) as error:
            raise EmbeddingServiceError(
                "Embedding index has an invalid structure.",
                code="INDEX_INVALID",
            ) from error

        return cls(model, model_digest, dimension, checksum, recipe_ids, vectors)

    def save(self, path: Path) -> None:
        """Atomically write the complete cache so interruption cannot corrupt it."""

        document = {
            "schema_version": INDEX_SCHEMA_VERSION,
            "model": self.model,
            "model_digest": self.model_digest,
            "dimension": self.dimension,
            "corpus_checksum": self.corpus_checksum,
            "recipe_ids": list(self.recipe_ids),
            "vectors": self.vectors.tolist(),
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = path.with_suffix(f"{path.suffix}.tmp")
        temporary_path.write_text(
            json.dumps(document, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary_path.replace(path)

    def is_compatible(
        self,
        recipes: list[Recipe] | tuple[Recipe, ...],
        *,
        model: str,
        model_digest: str,
        expected_dimension: int,
    ) -> bool:
        """Return whether this cache is safe for the current corpus and model."""

        return (
            self.model == model
            and self.model_digest == model_digest
            and self.dimension == expected_dimension
            and self.corpus_checksum == corpus_checksum(recipes)
            and self.recipe_ids == tuple(recipe.id for recipe in recipes)
        )

    def similarities(self, query_vector: list[float]) -> dict[str, float]:
        """Compute cosine similarity and map the [-1, 1] range into [0, 1]."""

        query = np.asarray(query_vector, dtype=np.float32)
        if query.ndim != 1 or query.shape[0] != self.dimension or not np.isfinite(query).all():
            raise EmbeddingServiceError(
                "Query embedding has an invalid dimension or value.",
                code="VECTOR_INTEGRITY_ERROR",
            )
        norm = float(np.linalg.norm(query))
        if norm <= 0:
            raise EmbeddingServiceError(
                "Query embedding cannot be a zero vector.",
                code="VECTOR_INTEGRITY_ERROR",
            )
        normalized_query = query / norm
        vector_norms = np.linalg.norm(self.vectors, axis=1, keepdims=True)
        normalized_vectors = self.vectors / vector_norms
        similarities = normalized_vectors @ normalized_query
        return {
            recipe_id: float(np.clip((score + 1.0) / 2.0, 0.0, 1.0))
            for recipe_id, score in zip(self.recipe_ids, similarities, strict=True)
        }


class OllamaEmbeddingClient:
    """Bounded, validated wrapper around Ollama's official Python client."""

    def __init__(
        self,
        *,
        host: str,
        model: str,
        expected_dimension: int,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        batch_size: int = 32,
    ) -> None:
        self.host = host.rstrip("/")
        self.model = model
        self.expected_dimension = expected_dimension
        self.batch_size = batch_size
        self._timeout = httpx.Timeout(
            connect=connect_timeout_seconds,
            read=read_timeout_seconds,
            write=30.0,
            pool=5.0,
        )
        self._client = ollama.Client(host=self.host, timeout=self._timeout)

    def close(self) -> None:
        """Release HTTP connection pools held by the Ollama client."""

        self._client.close()

    def __enter__(self) -> "OllamaEmbeddingClient":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed text in bounded batches and validate every returned vector."""

        if not texts or not all(isinstance(text, str) and text.strip() for text in texts):
            raise EmbeddingServiceError(
                "Embedding input must be a non-empty list of non-empty strings.",
                code="INVALID_EMBEDDING_INPUT",
            )

        all_vectors: list[list[float]] = []
        for start in range(0, len(texts), self.batch_size):
            batch = texts[start : start + self.batch_size]
            response = self._request_embed(batch)
            raw_vectors = getattr(response, "embeddings", None)
            if raw_vectors is None and isinstance(response, dict):
                raw_vectors = response.get("embeddings")
            if not isinstance(raw_vectors, list) or len(raw_vectors) != len(batch):
                raise EmbeddingServiceError(
                    "Ollama returned the wrong number of embeddings.",
                    code="VECTOR_INTEGRITY_ERROR",
                )
            for vector in raw_vectors:
                validated = _validate_vector(vector, self.expected_dimension)
                all_vectors.append(validated)
        return all_vectors

    def _request_embed(self, batch: list[str]) -> Any:
        """Retry only transient Ollama failures with a short bounded backoff."""

        for attempt in range(3):
            try:
                return self._client.embed(
                    model=self.model,
                    input=batch,
                    truncate=False,
                    keep_alive="5m",
                )
            except ollama.ResponseError as error:
                status = getattr(error, "status_code", None)
                retryable = status in RETRYABLE_STATUS_CODES
                if retryable and attempt < 2:
                    time.sleep(0.2 * (2**attempt))
                    continue
                code = "OLLAMA_MODEL_MISSING" if status == 404 else "OLLAMA_UPSTREAM_ERROR"
                raise EmbeddingServiceError(
                    f"Ollama embedding request failed: {getattr(error, 'error', str(error))}",
                    code=code,
                    retryable=retryable,
                ) from error
            except (ConnectionError, httpx.TimeoutException, httpx.ConnectError) as error:
                if attempt < 2:
                    time.sleep(0.2 * (2**attempt))
                    continue
                raise EmbeddingServiceError(
                    "Ollama is unavailable or timed out.",
                    code="OLLAMA_UNAVAILABLE",
                    retryable=True,
                ) from error
        raise AssertionError("retry loop must return or raise")

    def model_digest(self) -> str:
        """Return the installed model digest used to invalidate stale indexes."""

        try:
            response = self._client.list()
        except (ConnectionError, httpx.HTTPError, ollama.ResponseError) as error:
            raise EmbeddingServiceError(
                "Could not list installed Ollama models.",
                code="OLLAMA_UNAVAILABLE",
                retryable=True,
            ) from error
        models = getattr(response, "models", None)
        if models is None and isinstance(response, dict):
            models = response.get("models", [])
        for model_info in models or []:
            name = _get_value(model_info, "model") or _get_value(model_info, "name")
            if _model_names_match(str(name or ""), self.model):
                digest = _get_value(model_info, "digest")
                if isinstance(digest, str) and digest:
                    return digest
        raise EmbeddingServiceError(
            f"Ollama model '{self.model}' is not installed. Run: ollama pull {self.model}",
            code="OLLAMA_MODEL_MISSING",
        )

    def status(self, *, probe: bool = False) -> OllamaStatus:
        """Report offline, server, model, or fully ready state."""

        try:
            with httpx.Client(timeout=self._timeout) as client:
                response = client.get(f"{self.host}/api/version")
                response.raise_for_status()
                version = str(response.json().get("version", "")) or None
        except (httpx.HTTPError, ValueError) as error:
            return OllamaStatus(
                "offline", None, self.model, None, None, f"Ollama unavailable: {error}"
            )

        if (
            self.model == "embeddinggemma"
            and version
            and _version_tuple(version) < MIN_EMBEDDINGGEMMA_VERSION
        ):
            return OllamaStatus(
                "server_available",
                version,
                self.model,
                None,
                None,
                "EmbeddingGemma requires Ollama 0.11.10 or newer.",
            )
        try:
            digest = self.model_digest()
        except EmbeddingServiceError as error:
            return OllamaStatus(
                "server_available", version, self.model, None, None, str(error)
            )
        if not probe:
            return OllamaStatus(
                "model_available", version, self.model, digest, None, "Model is installed."
            )
        try:
            vector = self.embed(["Dishly embedding readiness check"])[0]
        except EmbeddingServiceError as error:
            return OllamaStatus(
                "model_available", version, self.model, digest, None, str(error)
            )
        return OllamaStatus(
            "ready", version, self.model, digest, len(vector), "Ollama embeddings are ready."
        )


def _validate_vector(raw_vector: Any, expected_dimension: int) -> list[float]:
    if not isinstance(raw_vector, list) or len(raw_vector) != expected_dimension:
        raise EmbeddingServiceError(
            f"Embedding vector must contain {expected_dimension} values.",
            code="VECTOR_INTEGRITY_ERROR",
        )
    vector = [float(value) for value in raw_vector]
    if not all(math.isfinite(value) for value in vector) or math.sqrt(
        sum(value * value for value in vector)
    ) <= 0:
        raise EmbeddingServiceError(
            "Embedding vector contains non-finite values or is zero.",
            code="VECTOR_INTEGRITY_ERROR",
        )
    return vector


def _validate_matrix(matrix: np.ndarray, rows: int, dimension: int) -> None:
    if matrix.shape != (rows, dimension) or not np.isfinite(matrix).all():
        raise EmbeddingServiceError(
            "Embedding matrix has an invalid shape or non-finite value.",
            code="VECTOR_INTEGRITY_ERROR",
        )
    if rows and np.any(np.linalg.norm(matrix, axis=1) <= 0):
        raise EmbeddingServiceError(
            "Embedding matrix contains a zero vector.",
            code="VECTOR_INTEGRITY_ERROR",
        )


def _get_value(value: Any, name: str) -> Any:
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)


def _model_names_match(installed: str, configured: str) -> bool:
    installed_base = installed.removesuffix(":latest")
    configured_base = configured.removesuffix(":latest")
    return installed == configured or installed_base == configured_base


def _version_tuple(value: str) -> tuple[int, int, int]:
    parts: list[int] = []
    for raw_part in value.split(".")[:3]:
        match = re.match(r"\d+", raw_part)
        parts.append(int(match.group() if match else 0))
    padded = (*parts, 0, 0, 0)
    return padded[0], padded[1], padded[2]
