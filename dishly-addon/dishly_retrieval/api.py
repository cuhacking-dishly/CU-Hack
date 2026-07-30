"""Private FastAPI service consumed only by Dishly's Express backend."""

import re
import secrets
from contextlib import asynccontextmanager
from threading import Lock
from typing import Annotated, Any, Literal

from fastapi import FastAPI, HTTPException, Path, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .config import Settings
from .dataset import DatasetValidationError
from .goal_parser import GoalParserError, OllamaGoalParser
from .models import SearchRequest
from .retrieval import RetrievalEngine

CANONICAL_RECIPE_ID = re.compile(r"^[1-9]\d*$")


class ParseGoalPayload(BaseModel):
    """One bounded natural-language request from the public Express API."""

    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=1000)


class SearchPayload(BaseModel):
    """Strict private HTTP contract sent by the Express adapter."""

    model_config = ConfigDict(extra="forbid")

    raw_query: str = Field(min_length=1, max_length=1000)
    # Express uses null when the local parser intentionally omits a suspicious
    # soft query. Retrieval then embeds the original raw_query instead.
    query: str | None = Field(default=None, max_length=200)
    preferred_cuisines: list[str] = Field(default_factory=list, max_length=8)
    preferred_meal_type: str | None = Field(default=None, max_length=80)
    diet: str | None = Field(default=None, max_length=80)
    require_vegan: bool = False
    excluded_allergens: list[str] = Field(default_factory=list, max_length=24)
    excluded_ingredients: list[str] = Field(default_factory=list, max_length=50)
    min_calories: float | None = Field(default=None, ge=0)
    max_calories: float | None = Field(default=None, ge=0)
    min_protein_g: float | None = Field(default=None, ge=0)
    max_protein_g: float | None = Field(default=None, ge=0)
    min_carbs_g: float | None = Field(default=None, ge=0)
    max_carbs_g: float | None = Field(default=None, ge=0)
    max_time_minutes: int | None = Field(default=None, ge=0)
    excluded_recipe_ids: list[str] = Field(default_factory=list, max_length=1000)
    limit: int = Field(default=10, ge=1, le=20)
    offset: int = Field(default=0, ge=0, le=10000)
    match_mode: Literal["exact", "closest"] = "exact"

    @model_validator(mode="after")
    def validate_ranges_and_ids(self) -> "SearchPayload":
        """Reject contradictory ranges and non-canonical local recipe IDs."""

        for minimum_name, maximum_name in (
            ("min_calories", "max_calories"),
            ("min_protein_g", "max_protein_g"),
            ("min_carbs_g", "max_carbs_g"),
        ):
            minimum = getattr(self, minimum_name)
            maximum = getattr(self, maximum_name)
            if minimum is not None and maximum is not None and minimum > maximum:
                raise ValueError(f"{minimum_name} cannot exceed {maximum_name}")
        if any(not CANONICAL_RECIPE_ID.fullmatch(value) for value in self.excluded_recipe_ids):
            raise ValueError("excluded_recipe_ids must contain canonical positive IDs")
        return self

    def to_domain(self) -> SearchRequest:
        """Convert validated transport lists into immutable domain collections."""

        return SearchRequest(
            raw_query=self.raw_query.strip(),
            query=self.query.strip() if self.query else "",
            excluded_allergens=frozenset(value.strip() for value in self.excluded_allergens),
            excluded_ingredients=frozenset(
                value.strip() for value in self.excluded_ingredients
            ),
            preferred_cuisines=tuple(value.strip() for value in self.preferred_cuisines),
            preferred_meal_type=(
                self.preferred_meal_type.strip() if self.preferred_meal_type else None
            ),
            diet=self.diet.strip() if self.diet else None,
            require_vegan=(
                self.require_vegan
                or (self.diet is not None and self.diet.strip().lower() == "vegan")
            ),
            min_calories=self.min_calories,
            max_calories=self.max_calories,
            min_protein_g=self.min_protein_g,
            max_protein_g=self.max_protein_g,
            min_carbs_g=self.min_carbs_g,
            max_carbs_g=self.max_carbs_g,
            max_time_minutes=self.max_time_minutes,
            excluded_recipe_ids=frozenset(self.excluded_recipe_ids),
            limit=self.limit,
            offset=self.offset,
            match_mode=self.match_mode,
        )


class EngineContainer:
    """Load the corpus once and expose one thread-safe engine instance."""

    def __init__(
        self,
        settings: Settings,
        engine: RetrievalEngine | None = None,
        goal_parser: OllamaGoalParser | None = None,
    ) -> None:
        self.settings = settings
        self._engine = engine
        self._goal_parser = goal_parser
        self._load_error: Exception | None = None
        self._lock = Lock()

    def get(self) -> RetrievalEngine:
        """Return the engine, attempting one lazy load when needed."""

        if self._engine is not None:
            return self._engine
        with self._lock:
            if self._engine is not None:
                return self._engine
            try:
                self._engine = RetrievalEngine.from_settings(self.settings)
                self._load_error = None
            except Exception as error:
                self._load_error = error
                raise
            return self._engine

    def get_parser(self) -> OllamaGoalParser:
        """Return the single local parser client, creating it only when used."""

        if self._goal_parser is not None:
            return self._goal_parser
        with self._lock:
            if self._goal_parser is None:
                self._goal_parser = OllamaGoalParser(
                    host=self.settings.ollama_host,
                    model=self.settings.ollama_parser_model,
                    connect_timeout_seconds=self.settings.ollama_connect_timeout_seconds,
                    read_timeout_seconds=self.settings.ollama_parser_timeout_seconds,
                )
            return self._goal_parser

    def close(self) -> None:
        if self._engine is not None:
            self._engine.close()
        if self._goal_parser is not None:
            self._goal_parser.close()

    @property
    def load_error(self) -> Exception | None:
        return self._load_error


def create_app(
    *,
    settings: Settings | None = None,
    engine: RetrievalEngine | None = None,
    goal_parser: OllamaGoalParser | None = None,
) -> FastAPI:
    """Create an independently testable private retrieval application."""

    resolved_settings = settings or Settings.from_environment()
    container = EngineContainer(resolved_settings, engine, goal_parser)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        container.close()

    application = FastAPI(
        title="Dishly Local Retrieval",
        version="1.0.0",
        docs_url="/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    application.state.engine_container = container

    @application.middleware("http")
    async def authenticate_private_service(request: Request, call_next: Any) -> Any:
        token = resolved_settings.service_token
        if token is None or request.url.path == "/health":
            return await call_next(request)

        authorization = request.headers.get("authorization", "")
        scheme, separator, credential = authorization.partition(" ")
        is_authorized = (
            separator == " "
            and scheme.lower() == "bearer"
            and secrets.compare_digest(credential, token)
        )
        if not is_authorized:
            return JSONResponse(
                status_code=401,
                content={"detail": "Private service authentication required"},
            )
        return await call_next(request)

    @application.get("/health")
    def health() -> dict[str, object]:
        return {"ok": True, "service": "dishly-retrieval", "version": "1.0.0"}

    @application.get("/ready")
    def ready() -> JSONResponse:
        try:
            status = container.get().readiness()
            parser_status = container.get_parser().status()
        except (DatasetValidationError, OSError, ValueError) as error:
            return JSONResponse(
                status_code=503,
                content={"ok": False, "error": str(error)},
            )
        status["parser"] = {
            "state": parser_status.state,
            "model": parser_status.model,
            "modelDigest": parser_status.model_digest,
            "message": parser_status.message,
        }
        status["ok"] = bool(status["ok"] and parser_status.state == "ready")
        return JSONResponse(status_code=200 if status["ok"] else 503, content=status)

    @application.post("/v1/parse-goal")
    def parse_goal(payload: ParseGoalPayload) -> dict[str, object]:
        """Parse entirely through the configured local Ollama server."""

        try:
            parsed_filter = container.get_parser().parse(payload.text)
        except GoalParserError as error:
            if error.code == "INVALID_GOAL_TEXT":
                status_code = 400
            elif error.code == "OLLAMA_INVALID_RESPONSE":
                status_code = 502
            elif error.code == "OLLAMA_TIMEOUT":
                status_code = 504
            else:
                status_code = 503
            raise HTTPException(status_code=status_code, detail=str(error)) from error
        return {
            "parsedFilter": parsed_filter,
            "parserProvider": f"ollama:{container.get_parser().model}",
        }

    @application.post("/v1/search")
    def search(payload: SearchPayload) -> dict[str, object]:
        try:
            response = container.get().search(payload.to_domain())
        except (DatasetValidationError, OSError) as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return response.to_api_dict()

    @application.get("/v1/recipes/{recipe_id}")
    def get_recipe(
        recipe_id: Annotated[str, Path(min_length=1, max_length=16)],
    ) -> dict[str, object]:
        if not CANONICAL_RECIPE_ID.fullmatch(recipe_id):
            raise HTTPException(status_code=400, detail="recipe_id must be a positive integer")
        try:
            recipe = container.get().get_recipe(recipe_id)
        except (DatasetValidationError, OSError) as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        if recipe is None:
            raise HTTPException(status_code=404, detail="Recipe not found")
        return recipe.to_public_dict()

    @application.exception_handler(DatasetValidationError)
    async def dataset_error_handler(_request: Any, error: DatasetValidationError) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(error)})

    return application


app = create_app()
