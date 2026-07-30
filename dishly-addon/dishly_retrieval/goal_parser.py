"""Local natural-language goal parsing with a deterministic safety overlay.

Ollama handles the fuzzy language understanding. Explicit allergy and ingredient
exclusions are then recovered directly from the user's original words and merged
into the model output. This division matters: model interpretation may be soft,
but Dishly must never silently drop a clearly stated safety constraint.
"""

import json
import re
import time
from dataclasses import dataclass
from typing import Any, Literal

import httpx
import ollama
from pydantic import BaseModel, ConfigDict, Field, model_validator

DIETS = Literal[
    "gluten free",
    "ketogenic",
    "vegetarian",
    "lacto-vegetarian",
    "ovo-vegetarian",
    "vegan",
    "pescetarian",
    "paleo",
    "primal",
    "low fodmap",
    "whole30",
]
CUISINES = Literal[
    "african",
    "asian",
    "american",
    "british",
    "cajun",
    "caribbean",
    "chinese",
    "eastern european",
    "european",
    "french",
    "german",
    "greek",
    "indian",
    "irish",
    "italian",
    "japanese",
    "jewish",
    "korean",
    "latin american",
    "mediterranean",
    "mexican",
    "middle eastern",
    "nordic",
    "southern",
    "spanish",
    "thai",
    "vietnamese",
]
MEAL_TYPES = Literal["breakfast", "main course", "dessert"]
INTOLERANCES = Literal[
    "dairy",
    "egg",
    "gluten",
    "grain",
    "peanut",
    "seafood",
    "sesame",
    "shellfish",
    "soy",
    "sulfite",
    "tree nut",
    "wheat",
]

RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}
ALLERGEN_ALIASES = {
    "dairy": "dairy",
    "milk": "dairy",
    "lactose": "dairy",
    "egg": "egg",
    "eggs": "egg",
    "gluten": "gluten",
    "grain": "grain",
    "grains": "grain",
    "peanut": "peanut",
    "peanuts": "peanut",
    "seafood": "seafood",
    "fish": "seafood",
    "sesame": "sesame",
    "shellfish": "shellfish",
    "shrimp": "shellfish",
    "prawns": "shellfish",
    "soy": "soy",
    "soya": "soy",
    "soybeans": "soy",
    "sulfite": "sulfite",
    "sulfites": "sulfite",
    "tree nut": "tree nut",
    "tree nuts": "tree nut",
    "treenuts": "tree nut",
    "wheat": "wheat",
}

# Capture only phrases that explicitly negate an ingredient. Numeric phrases
# such as "no more than 600 calories" are excluded before they reach this rule.
EXCLUSION_PATTERN = re.compile(
    r"\b(?:allergic\s+to|allergy\s+to|without|avoid(?:ing)?|exclude(?:ing)?|"
    r"can(?:not|'t)\s+eat|free\s+(?:from|of)|no(?!\s+more\s+than))\s+"
    r"(?P<items>[^,.;]+)",
    re.IGNORECASE,
)
BOUNDARY_PATTERN = re.compile(
    r"\b(?:but|with|for|under|over|at\s+least|at\s+most|less\s+than|"
    r"more\s+than|ready\s+in|that\s+has|around)\b",
    re.IGNORECASE,
)
IGNORED_EXCLUSIONS = {
    "preference",
    "preferences",
    "restriction",
    "restrictions",
    "time",
    "limit",
    "limits",
}
EXPLICIT_CUISINES = (
    "african",
    "asian",
    "american",
    "british",
    "cajun",
    "caribbean",
    "chinese",
    "eastern european",
    "european",
    "french",
    "german",
    "greek",
    "indian",
    "irish",
    "italian",
    "japanese",
    "jewish",
    "korean",
    "latin american",
    "mediterranean",
    "mexican",
    "middle eastern",
    "nordic",
    "southern",
    "spanish",
    "thai",
    "vietnamese",
)

SYSTEM_PROMPT = """You parse a Dishly recipe request into structured search fields.
Return only data matching the supplied JSON schema.

Rules:
- Extract every explicit constraint. Preserve intent; never invent a restriction.
- "no", "without", "avoid", "allergic to", and "cannot eat" ingredients belong
  in excludeIngredients. Also add the canonical intolerance when one exists.
- Treat an explicit vegan request as diet="vegan". Vegan is a hard yes/no rule.
- Cuisine must be accurate. Use "asian" for broad Asian requests and a specific
  cuisine when the user names one. Do not infer cuisine from one ingredient.
- Map lunch, dinner, supper, entree, and main dish to mealType="main course".
- A requested amount such as "50g protein" is a minimum unless the user says
  maximum/under. "Around" values are search guidance, not allergies.
- Put only remaining descriptive food keywords in query. Never copy the entire
  request into query and omit cuisine, meal, numeric, diet, or exclusion fields.
- Omit fields the user did not request. Use empty arrays for absent array fields.
"""


class ParsedGoal(BaseModel):
    """The exact camelCase filter contract accepted by the Express backend."""

    model_config = ConfigDict(extra="forbid")

    query: str | None = Field(default=None, min_length=1, max_length=160)
    minCalories: int | None = Field(default=None, ge=0, le=10000)
    maxCalories: int | None = Field(default=None, ge=1, le=10000)
    minProtein_g: int | None = Field(default=None, ge=0, le=500)
    maxProtein_g: int | None = Field(default=None, ge=0, le=500)
    minCarbs_g: int | None = Field(default=None, ge=0, le=1000)
    maxCarbs_g: int | None = Field(default=None, ge=0, le=1000)
    diet: DIETS | None = None
    cuisines: list[CUISINES] = Field(default_factory=list, max_length=28)
    mealType: MEAL_TYPES | None = None
    maxReadyTime: int | None = Field(default=None, ge=1, le=1440)
    intolerances: list[INTOLERANCES] = Field(default_factory=list, max_length=12)
    excludeIngredients: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_ranges(self) -> "ParsedGoal":
        """Reject contradictory numeric bounds rather than guessing."""

        for minimum_name, maximum_name in (
            ("minCalories", "maxCalories"),
            ("minProtein_g", "maxProtein_g"),
            ("minCarbs_g", "maxCarbs_g"),
        ):
            minimum = getattr(self, minimum_name)
            maximum = getattr(self, maximum_name)
            if minimum is not None and maximum is not None and minimum > maximum:
                raise ValueError(f"{minimum_name} cannot exceed {maximum_name}")
        return self

    def compact_dict(self) -> dict[str, object]:
        """Remove null and empty values so saved goals stay easy to inspect."""

        result = self.model_dump(exclude_none=True)
        return {key: value for key, value in result.items() if value != []}


class GoalParserError(RuntimeError):
    """Stable local-provider error translated into an HTTP status by FastAPI."""

    def __init__(self, message: str, *, code: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class ParserStatus:
    """Readiness details for the configured local instruction model."""

    state: str
    model: str
    model_digest: str | None
    message: str


class OllamaGoalParser:
    """Validated, bounded wrapper around Ollama structured chat output."""

    def __init__(
        self,
        *,
        host: str,
        model: str,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
    ) -> None:
        self.host = host.rstrip("/")
        self.model = model
        self._timeout = httpx.Timeout(
            connect=connect_timeout_seconds,
            read=read_timeout_seconds,
            write=30.0,
            pool=5.0,
        )
        self._client = ollama.Client(host=self.host, timeout=self._timeout)

    def close(self) -> None:
        """Release the parser's local HTTP connection pool."""

        self._client.close()

    def parse(self, text: str) -> dict[str, object]:
        """Interpret one request, validate it, then enforce explicit exclusions."""

        normalized_text = " ".join(text.split())
        if not normalized_text or len(normalized_text) > 1000:
            raise GoalParserError(
                "Goal text must contain between 1 and 1000 characters.",
                code="INVALID_GOAL_TEXT",
            )

        schema = ParsedGoal.model_json_schema()
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": "Recipe request:\nAsian food for dinner with 50g protein and no peanuts",
            },
            {
                "role": "assistant",
                "content": (
                    '{"query":"food","minProtein_g":50,"cuisines":["asian"],'
                    '"mealType":"main course","intolerances":["peanut"],'
                    '"excludeIngredients":["peanuts"]}'
                ),
            },
            {
                "role": "user",
                "content": "Recipe request:\nVegan Italian lunch under 30 minutes",
            },
            {
                "role": "assistant",
                "content": (
                    '{"diet":"vegan","cuisines":["italian"],'
                    '"mealType":"main course","maxReadyTime":30}'
                ),
            },
            {
                "role": "user",
                "content": (
                    f"JSON schema:\n{json.dumps(schema, separators=(',', ':'))}\n\n"
                    f"Recipe request:\n{normalized_text}"
                ),
            },
        ]
        response = self._request_chat(messages, schema)
        content = _response_content(response)
        try:
            parsed = ParsedGoal.model_validate_json(content)
        except (ValueError, TypeError) as error:
            raise GoalParserError(
                "Ollama returned an invalid structured goal.",
                code="OLLAMA_INVALID_RESPONSE",
                retryable=True,
            ) from error
        return apply_explicit_constraints(normalized_text, parsed.compact_dict())

    def _request_chat(
        self,
        messages: list[dict[str, str]],
        schema: dict[str, Any],
    ) -> Any:
        """Retry transient local-server failures without hiding permanent ones."""

        for attempt in range(3):
            try:
                return self._client.chat(
                    model=self.model,
                    messages=messages,
                    format=schema,
                    options={
                        "temperature": 0,
                        "seed": 42,
                        "num_ctx": 4096,
                        "num_predict": 512,
                    },
                    think=False,
                    stream=False,
                    keep_alive="10m",
                )
            except ollama.ResponseError as error:
                status = getattr(error, "status_code", None)
                retryable = status in RETRYABLE_STATUS_CODES
                if retryable and attempt < 2:
                    time.sleep(0.25 * (2**attempt))
                    continue
                code = "OLLAMA_MODEL_MISSING" if status == 404 else "OLLAMA_UPSTREAM_ERROR"
                raise GoalParserError(
                    f"Ollama goal parsing failed: {getattr(error, 'error', str(error))}",
                    code=code,
                    retryable=retryable,
                ) from error
            except (ConnectionError, httpx.TimeoutException, httpx.ConnectError) as error:
                if attempt < 2:
                    time.sleep(0.25 * (2**attempt))
                    continue
                timed_out = isinstance(error, httpx.TimeoutException)
                raise GoalParserError(
                    (
                        "Ollama timed out while parsing the goal."
                        if timed_out
                        else "Ollama is unavailable while parsing the goal."
                    ),
                    code="OLLAMA_TIMEOUT" if timed_out else "OLLAMA_UNAVAILABLE",
                    retryable=True,
                ) from error
        raise AssertionError("retry loop must return or raise")

    def model_digest(self) -> str:
        """Return the exact installed parser model digest."""

        try:
            response = self._client.list()
        except (ConnectionError, httpx.HTTPError, ollama.ResponseError) as error:
            raise GoalParserError(
                "Could not list installed Ollama models.",
                code="OLLAMA_UNAVAILABLE",
                retryable=True,
            ) from error
        models = getattr(response, "models", None)
        if models is None and isinstance(response, dict):
            models = response.get("models", [])
        for model_info in models or []:
            name = _value(model_info, "model") or _value(model_info, "name")
            if _model_names_match(str(name or ""), self.model):
                digest = _value(model_info, "digest")
                if isinstance(digest, str) and digest:
                    return digest
        raise GoalParserError(
            f"Ollama model '{self.model}' is not installed. Run: ollama pull {self.model}",
            code="OLLAMA_MODEL_MISSING",
        )

    def status(self) -> ParserStatus:
        """Report whether the local parser model is installed and reachable."""

        try:
            digest = self.model_digest()
        except GoalParserError as error:
            state = "offline" if error.code == "OLLAMA_UNAVAILABLE" else "model_missing"
            return ParserStatus(state, self.model, None, str(error))
        return ParserStatus("ready", self.model, digest, "Local goal parser is ready.")


def apply_explicit_constraints(text: str, parsed: dict[str, object]) -> dict[str, object]:
    """Merge unmistakable user constraints into the model's validated result."""

    result = dict(parsed)
    _remove_ungrounded_numeric_fields(text, result)
    _sanitize_soft_query(result)
    if re.search(r"\bvegan\b", text, re.IGNORECASE):
        result["diet"] = "vegan"

    explicit_cuisines = _extract_explicit_cuisines(text)
    if explicit_cuisines:
        result["cuisines"] = explicit_cuisines

    if re.search(r"\b(?:breakfast|brunch|morning\s+meal)\b", text, re.IGNORECASE):
        result["mealType"] = "breakfast"
    elif re.search(
        r"\b(?:lunch|dinner|supper|entree|main\s+(?:course|dish))\b",
        text,
        re.IGNORECASE,
    ):
        result["mealType"] = "main course"
    elif re.search(r"\b(?:dessert|sweet\s+treat)\b", text, re.IGNORECASE):
        result["mealType"] = "dessert"

    explicit_ingredients = extract_explicit_exclusions(text)
    model_ingredients = [
        value.strip()
        for value in result.get("excludeIngredients", [])
        if isinstance(value, str) and value.strip()
    ]
    ingredients = _dedupe((*model_ingredients, *explicit_ingredients))[:20]
    if ingredients:
        result["excludeIngredients"] = ingredients

    model_intolerances = [
        value
        for value in result.get("intolerances", [])
        if isinstance(value, str)
    ]
    detected_intolerances = [
        canonical
        for ingredient in explicit_ingredients
        for alias, canonical in ALLERGEN_ALIASES.items()
        if re.search(rf"\b{re.escape(alias)}\b", ingredient, re.IGNORECASE)
    ]
    intolerances = _dedupe((*model_intolerances, *detected_intolerances))
    if intolerances:
        result["intolerances"] = intolerances[:12]

    _overlay_explicit_numbers(text, result)
    return ParsedGoal.model_validate(result).compact_dict()


def extract_explicit_exclusions(text: str) -> list[str]:
    """Recover explicit negative ingredient phrases from the original request."""

    found: list[str] = []
    for match in EXCLUSION_PATTERN.finditer(text):
        raw_items = BOUNDARY_PATTERN.split(match.group("items"), maxsplit=1)[0]
        for raw_item in re.split(r"\s+(?:and|or)\s+|/", raw_items, flags=re.IGNORECASE):
            item = " ".join(raw_item.strip(" -:'\"()[]").split()).lower()
            item = re.sub(r"^(?:any|all|foods?\s+(?:with|containing)|recipes?\s+with)\s+", "", item)
            if (
                item
                and item not in IGNORED_EXCLUSIONS
                and len(item) <= 80
                and not re.search(r"\b(?:calorie|protein|carb|minute|hour)s?\b", item)
            ):
                found.append(item)
    return _dedupe(found)


def _overlay_explicit_numbers(text: str, result: dict[str, object]) -> None:
    """Protect common numeric intent from occasional small-model omissions."""

    patterns = (
        (
            "minProtein_g",
            r"(?:at\s+least|minimum|min(?:imum)?\s+of|more\s+than|over|with|around)\s*"
            r"(?P<value>\d{1,3})\s*(?:g|grams?)\s*(?:of\s*)?protein\b",
        ),
        (
            "maxProtein_g",
            r"(?:at\s+most|maximum|max(?:imum)?\s+of|less\s+than|under)\s*"
            r"(?P<value>\d{1,3})\s*(?:g|grams?)\s*(?:of\s*)?protein\b",
        ),
        (
            "maxCalories",
            r"(?:at\s+most|maximum|max(?:imum)?\s+of|less\s+than|under)\s*"
            r"(?P<value>\d{1,5})\s*calories?\b",
        ),
        (
            "maxReadyTime",
            r"(?:within|under|less\s+than|at\s+most|ready\s+in)\s*"
            r"(?P<value>\d{1,4})\s*(?:minutes?|mins?)\b",
        ),
    )
    limits = {"minProtein_g": 500, "maxProtein_g": 500, "maxCalories": 10000, "maxReadyTime": 1440}
    for field, pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            value = int(match.group("value"))
            if 0 < value <= limits[field]:
                result[field] = value


def _remove_ungrounded_numeric_fields(text: str, result: dict[str, object]) -> None:
    """Discard numeric constraints that have no matching concept in user text.

    Small local models sometimes fill optional integers with zero. A zero-value
    minimum adds no value, while an invented non-zero bound would distort
    ranking. Grounding each numeric family in the original text prevents both.
    """

    concept_fields = {
        r"\bcalor(?:ie|ies|ic)\b": ("minCalories", "maxCalories"),
        r"\bprotein\b": ("minProtein_g", "maxProtein_g"),
        r"\bcarb(?:ohydrate)?s?\b": ("minCarbs_g", "maxCarbs_g"),
        r"\b(?:minutes?|mins?|hours?|hrs?)\b": ("maxReadyTime",),
    }
    for pattern, fields in concept_fields.items():
        grounded = re.search(pattern, text, re.IGNORECASE) is not None
        for field in fields:
            value = result.get(field)
            if not grounded or value == 0:
                result.pop(field, None)


def _sanitize_soft_query(result: dict[str, object]) -> None:
    """Drop malformed model prose; retrieval then safely uses the raw request."""

    query = result.get("query")
    if not isinstance(query, str):
        result.pop("query", None)
        return
    normalized = " ".join(query.split()).strip()
    schema_leak = re.search(
        r"(?:cuisines|mealType|minProtein_g|maxProtein_g|minCalories|"
        r"maxCalories|intolerances|excludeIngredients)\s*['\"]?\s*[:\]]",
        normalized,
        re.IGNORECASE,
    )
    if (
        not normalized
        or schema_leak
        or any(character in normalized for character in "{}[]")
        or normalized.count("'") >= 2
        or normalized.count('"') >= 2
    ):
        result.pop("query", None)
    else:
        result["query"] = normalized


def _extract_explicit_cuisines(text: str) -> list[str]:
    """Recover cuisine names used in an unmistakable cuisine/meal context."""

    found: list[str] = []
    for cuisine in EXPLICIT_CUISINES:
        escaped = re.escape(cuisine)
        if re.search(
            rf"\b{escaped}\s+(?:food|cuisine|dish(?:es)?|meal|lunch|dinner|breakfast)\b",
            text,
            re.IGNORECASE,
        ) or re.search(
            rf"\b(?:want|craving|make|cook|eat|for)\s+(?:some\s+)?{escaped}\b",
            text,
            re.IGNORECASE,
        ):
            found.append(cuisine)
    return found[:8]


def _response_content(response: Any) -> str:
    message = getattr(response, "message", None)
    if message is None and isinstance(response, dict):
        message = response.get("message")
    content = _value(message, "content")
    if not isinstance(content, str) or not content.strip():
        raise GoalParserError(
            "Ollama returned an empty goal response.",
            code="OLLAMA_INVALID_RESPONSE",
            retryable=True,
        )
    return content


def _dedupe(values: tuple[str, ...] | list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        key = value.casefold()
        if key not in seen:
            seen.add(key)
            result.append(value)
    return result


def _value(value: Any, name: str) -> Any:
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)


def _model_names_match(installed: str, configured: str) -> bool:
    return installed.removesuffix(":latest") == configured.removesuffix(":latest")
