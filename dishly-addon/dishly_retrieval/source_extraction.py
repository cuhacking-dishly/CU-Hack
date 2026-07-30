"""Extract reviewable Schema.org Recipe metadata from publisher HTML."""

import json
import math
import re
from collections.abc import Iterator
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

from .dataset import is_public_http_url


class RecipeExtractionError(ValueError):
    """Explain why a source page cannot produce a review candidate."""


@dataclass(frozen=True, slots=True)
class ImageCandidate:
    """One publisher image URL with optional declared dimensions."""

    url: str
    width: int | None = None
    height: int | None = None

    @property
    def declared_area(self) -> int:
        return (self.width or 0) * (self.height or 0)


@dataclass(frozen=True, slots=True)
class ExtractedRecipeMetadata:
    """Source-backed fields awaiting quality and dietary review."""

    title: str
    ingredients: tuple[str, ...]
    source_url: str
    image_candidates: tuple[ImageCandidate, ...]
    source_name: str
    cuisine: str | None
    description: str | None
    protein_grams: float | None
    calories: float | None
    carbs_grams: float | None
    fat_grams: float | None
    time_minutes: int | None
    servings: float | None

    @property
    def image_url(self) -> str | None:
        """Choose the largest publisher-declared candidate, then first valid URL."""

        if not self.image_candidates:
            return None
        return max(
            enumerate(self.image_candidates),
            key=lambda item: (item[1].declared_area, -item[0]),
        )[1].url


class _JsonLdScriptCollector(HTMLParser):
    """Collect complete ``application/ld+json`` script bodies."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.documents: list[str] = []
        self._inside = False
        self._parts: list[str] = []

    def handle_starttag(
        self,
        tag: str,
        attributes: list[tuple[str, str | None]],
    ) -> None:
        if tag.lower() != "script":
            return
        attributes_by_name = {name.lower(): value for name, value in attributes}
        script_type = (attributes_by_name.get("type") or "").split(";", 1)[0].strip().lower()
        if script_type == "application/ld+json":
            self._inside = True
            self._parts = []

    def handle_data(self, data: str) -> None:
        if self._inside:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script" and self._inside:
            document = "".join(self._parts).strip()
            if document:
                self.documents.append(document)
            self._inside = False
            self._parts = []


ISO_DURATION_PATTERN = re.compile(
    r"^P(?:(?P<days>\d+)D)?(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?)?$"
)
NUMBER_PATTERN = re.compile(r"[-+]?\d[\d,]*(?:\.\d+)?")
HTML_TAG_PATTERN = re.compile(r"<[^>]+>")


def extract_recipe_metadata(html: str, source_url: str) -> ExtractedRecipeMetadata:
    """Extract the best Recipe object tied to one exact publisher URL."""

    if not is_public_http_url(source_url):
        raise RecipeExtractionError("source_url must be a public HTTP(S) URL.")
    collector = _JsonLdScriptCollector()
    collector.feed(html)
    collector.close()

    recipe_node = find_recipe_node(collector.documents, source_url)
    if recipe_node is None:
        raise RecipeExtractionError("No Schema.org Recipe data was found on this page.")

    ingredients = require_string_tuple(recipe_node, "recipeIngredient")
    nutrition = recipe_node.get("nutrition")
    return ExtractedRecipeMetadata(
        title=require_text(recipe_node, "name"),
        ingredients=ingredients,
        source_url=source_url,
        image_candidates=extract_image_candidates(recipe_node.get("image"), source_url),
        source_name=extract_source_name(recipe_node, source_url),
        cuisine=extract_text_or_list(recipe_node.get("recipeCuisine")),
        description=extract_plain_text(recipe_node.get("description")),
        protein_grams=extract_number_from_mapping(nutrition, "proteinContent"),
        calories=extract_number_from_mapping(nutrition, "calories"),
        carbs_grams=extract_number_from_mapping(nutrition, "carbohydrateContent"),
        fat_grams=extract_number_from_mapping(nutrition, "fatContent"),
        time_minutes=parse_iso_duration(recipe_node.get("totalTime")),
        servings=parse_servings(recipe_node.get("recipeYield")),
    )


def find_recipe_node(
    documents: list[str],
    source_url: str | None = None,
) -> dict[str, Any] | None:
    """Select the strongest Recipe node, preferring an exact page URL match."""

    candidates: list[tuple[int, dict[str, Any]]] = []
    for document in documents:
        try:
            parsed = json.loads(document)
        except json.JSONDecodeError:
            continue
        for node in walk_json_ld_nodes(parsed):
            if not is_recipe_node(node):
                continue
            score = 0
            node_url = extract_node_url(node)
            if (
                source_url
                and node_url
                and canonical_page_url(node_url) == canonical_page_url(source_url)
            ):
                score += 1000
            ingredients = node.get("recipeIngredient")
            if isinstance(ingredients, list):
                score += min(len(ingredients), 100)
            if node.get("image"):
                score += 10
            if node.get("name"):
                score += 10
            candidates.append((score, node))
    return max(candidates, key=lambda candidate: candidate[0])[1] if candidates else None


def walk_json_ld_nodes(value: Any) -> Iterator[dict[str, Any]]:
    """Yield objects nested in arrays and JSON-LD ``@graph`` containers."""

    if isinstance(value, list):
        for item in value:
            yield from walk_json_ld_nodes(item)
        return
    if not isinstance(value, dict):
        return
    yield value
    graph = value.get("@graph")
    if isinstance(graph, list):
        for item in graph:
            yield from walk_json_ld_nodes(item)


def is_recipe_node(node: dict[str, Any]) -> bool:
    """Accept only the exact Recipe Schema.org type, including full URLs."""

    raw_type = node.get("@type")
    raw_types = raw_type if isinstance(raw_type, list) else [raw_type]
    for value in raw_types:
        if not isinstance(value, str):
            continue
        normalized = value.rstrip("/")
        if normalized == "Recipe" or normalized.rsplit("/", 1)[-1] == "Recipe":
            return True
    return False


def require_text(node: dict[str, Any], field_name: str) -> str:
    value = extract_plain_text(node.get(field_name))
    if value is None:
        raise RecipeExtractionError(f"Recipe JSON-LD needs a non-empty {field_name}.")
    return value


def require_string_tuple(node: dict[str, Any], field_name: str) -> tuple[str, ...]:
    value = node.get(field_name)
    values = value if isinstance(value, list) else [value]
    result = tuple(
        cleaned
        for item in values
        if (cleaned := extract_plain_text(item)) is not None
    )
    if not result:
        raise RecipeExtractionError(f"Recipe JSON-LD needs a non-empty {field_name} list.")
    return result


def extract_plain_text(value: Any) -> str | None:
    """Collapse source whitespace and remove embedded presentational HTML tags."""

    if not isinstance(value, str):
        return None
    cleaned = unescape(HTML_TAG_PATTERN.sub(" ", value))
    cleaned = " ".join(cleaned.split())
    return cleaned or None


def extract_text_or_list(value: Any) -> str | None:
    if isinstance(value, list):
        values = [text for item in value if (text := extract_plain_text(item))]
        return ", ".join(values) or None
    return extract_plain_text(value)


def extract_image_candidates(value: Any, source_url: str) -> tuple[ImageCandidate, ...]:
    """Normalize common string, ImageObject, and list Schema.org shapes."""

    candidates: list[ImageCandidate] = []
    for raw_candidate in value if isinstance(value, list) else [value]:
        width: int | None = None
        height: int | None = None
        if isinstance(raw_candidate, dict):
            raw_url = raw_candidate.get("contentUrl") or raw_candidate.get("url")
            width = parse_positive_integer(raw_candidate.get("width"))
            height = parse_positive_integer(raw_candidate.get("height"))
        else:
            raw_url = raw_candidate
        if not isinstance(raw_url, str) or not raw_url.strip():
            continue
        resolved_url = urljoin(source_url, raw_url.strip())
        if is_public_http_url(resolved_url):
            promoted_url = promote_publisher_image_size(resolved_url)
            if promoted_url != resolved_url:
                candidates.append(ImageCandidate(promoted_url))
            original_url = strip_cdn_resize_parameters(resolved_url)
            if original_url != resolved_url:
                candidates.append(ImageCandidate(original_url))
            candidates.append(ImageCandidate(resolved_url, width, height))

    # Deduplicate while preserving the largest declared shape for each URL.
    by_url: dict[str, ImageCandidate] = {}
    for candidate in candidates:
        existing = by_url.get(candidate.url)
        if existing is None or candidate.declared_area > existing.declared_area:
            by_url[candidate.url] = candidate
    return tuple(by_url.values())


def strip_cdn_resize_parameters(value: str) -> str:
    """Prefer the same publisher image without common downscaling parameters."""

    parsed = urlparse(value)
    resize_names = {"resize", "width", "height", "w", "h"}
    filtered_query = [
        (name, parameter)
        for name, parameter in parse_qsl(parsed.query, keep_blank_values=True)
        if name.lower() not in resize_names
    ]
    return urlunparse(parsed._replace(query=urlencode(filtered_query)))


def promote_publisher_image_size(value: str) -> str:
    """Ask BBC Good Food's own image CDN for its larger source derivative."""

    parsed = urlparse(value)
    if not parsed.hostname or not parsed.hostname.endswith("immediate.co.uk"):
        return value
    query = parse_qsl(parsed.query, keep_blank_values=True)
    if not any(name.lower() == "resize" for name, _parameter in query):
        return value
    promoted = [
        (name, "1100,1000") if name.lower() == "resize" else (name, parameter)
        for name, parameter in query
    ]
    return urlunparse(parsed._replace(query=urlencode(promoted)))


def extract_source_name(node: dict[str, Any], source_url: str) -> str:
    for field_name in ("publisher", "author"):
        values = node.get(field_name)
        for value in values if isinstance(values, list) else [values]:
            name = (
                extract_plain_text(value.get("name"))
                if isinstance(value, dict)
                else extract_plain_text(value)
            )
            if name:
                return name
    return urlparse(source_url).netloc.lower().removeprefix("www.")


def extract_number_from_mapping(value: Any, field_name: str) -> float | None:
    if not isinstance(value, dict):
        return None
    raw_value = value.get(field_name)
    if isinstance(raw_value, bool) or raw_value is None:
        return None
    if isinstance(raw_value, int | float):
        numeric = float(raw_value)
    elif isinstance(raw_value, str) and (match := NUMBER_PATTERN.search(raw_value)):
        numeric = float(match.group().replace(",", ""))
    else:
        return None
    return numeric if math.isfinite(numeric) and numeric >= 0 else None


def parse_iso_duration(value: Any) -> int | None:
    """Convert valid ISO durations such as PT1H15M; reject empty P/PT values."""

    if not isinstance(value, str):
        return None
    normalized = value.strip().upper()
    match = ISO_DURATION_PATTERN.fullmatch(normalized)
    if match is None or normalized in {"P", "PT"}:
        return None
    days = int(match.group("days") or 0)
    hours = int(match.group("hours") or 0)
    minutes = int(match.group("minutes") or 0)
    return days * 1440 + hours * 60 + minutes


def parse_servings(value: Any) -> float | None:
    """Read the first positive yield count without guessing from prose."""

    values = value if isinstance(value, list) else [value]
    for item in values:
        if isinstance(item, int | float) and not isinstance(item, bool):
            numeric = float(item)
        elif isinstance(item, str) and (match := NUMBER_PATTERN.search(item)):
            numeric = float(match.group().replace(",", ""))
        else:
            continue
        if math.isfinite(numeric) and numeric > 0:
            return numeric
    return None


def parse_positive_integer(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    if isinstance(value, str) and value.isascii() and value.isdecimal() and int(value) > 0:
        return int(value)
    return None


def extract_node_url(node: dict[str, Any]) -> str | None:
    value = node.get("url") or node.get("mainEntityOfPage")
    if isinstance(value, dict):
        value = value.get("@id") or value.get("url")
    return value if isinstance(value, str) else None


def canonical_page_url(value: str) -> str:
    parsed = urlparse(value)
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}{parsed.path.rstrip('/')}"
