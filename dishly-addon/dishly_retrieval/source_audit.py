"""Offline-only secure fetching and image-quality checks for corpus curation."""

import ipaddress
import socket
from collections.abc import Iterator
from dataclasses import dataclass
from io import BytesIO
from urllib.parse import urljoin, urlparse

import httpx
from PIL import Image, UnidentifiedImageError

from .dataset import (
    MIN_IMAGE_PIXELS,
    MIN_IMAGE_SHORT_SIDE,
    image_meets_quality_threshold,
    is_public_http_url,
)
from .source_extraction import ExtractedRecipeMetadata, extract_recipe_metadata

MAX_HTML_BYTES = 5 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_REDIRECTS = 5
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/136.0 Safari/537.36 DishlyCorpusAuditor/1.0"
)


class SourceAuditError(RuntimeError):
    """A source page or image failed a curation safety/quality requirement."""


@dataclass(frozen=True, slots=True)
class AuditedSource:
    """Structured source metadata plus a verified high-quality image."""

    metadata: ExtractedRecipeMetadata
    image_url: str
    image_width: int
    image_height: int
    image_format: str


class SafeSourceClient:
    """Bounded HTTP client that revalidates every redirect target."""

    def __init__(self, timeout_seconds: float = 20.0) -> None:
        self._client = httpx.Client(
            timeout=httpx.Timeout(timeout_seconds, connect=5.0),
            follow_redirects=False,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,image/avif,image/webp,image/*;q=0.8",
            },
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "SafeSourceClient":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def fetch_html(self, url: str) -> tuple[str, str]:
        """Fetch bounded HTML and return text plus the final public URL."""

        body, final_url, content_type = self._fetch(url, MAX_HTML_BYTES)
        if "html" not in content_type.lower():
            raise SourceAuditError(f"Source did not return HTML: {content_type or 'unknown'}")
        return body.decode(_charset_from_content_type(content_type), errors="replace"), final_url

    def inspect_image(self, url: str) -> tuple[int, int, str]:
        """Download a bounded image and verify its decoded dimensions."""

        body, _final_url, content_type = self._fetch(url, MAX_IMAGE_BYTES)
        if not content_type.lower().startswith("image/"):
            raise SourceAuditError(f"Image URL returned {content_type or 'unknown content'}")
        try:
            with Image.open(BytesIO(body)) as image:
                image.verify()
            with Image.open(BytesIO(body)) as image:
                width, height = image.size
                image_format = image.format or "unknown"
        except (UnidentifiedImageError, OSError) as error:
            raise SourceAuditError("Publisher image could not be decoded.") from error
        if not image_meets_quality_threshold(width, height):
            raise SourceAuditError(
                f"Publisher image is {width}x{height}; minimum is a "
                f"{MIN_IMAGE_SHORT_SIDE}px short side and {MIN_IMAGE_PIXELS:,} pixels."
            )
        return width, height, image_format

    def _fetch(self, initial_url: str, maximum_bytes: int) -> tuple[bytes, str, str]:
        current_url = initial_url
        for redirect_count in range(MAX_REDIRECTS + 1):
            _validate_public_destination(current_url)
            try:
                with self._client.stream("GET", current_url) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location:
                            raise SourceAuditError("Redirect response omitted Location.")
                        if redirect_count >= MAX_REDIRECTS:
                            raise SourceAuditError("Source exceeded the redirect limit.")
                        current_url = urljoin(current_url, location)
                        continue
                    response.raise_for_status()
                    content_length = response.headers.get("content-length")
                    if content_length:
                        try:
                            declared_length = int(content_length)
                        except ValueError:
                            declared_length = 0
                        if declared_length > maximum_bytes:
                            raise SourceAuditError("Source response exceeds the size limit.")
                    body = _read_bounded(response.iter_bytes(), maximum_bytes)
                    return (
                        body,
                        str(response.url),
                        response.headers.get("content-type", ""),
                    )
            except httpx.HTTPStatusError as error:
                raise SourceAuditError(
                    f"Source returned HTTP {error.response.status_code}."
                ) from error
            except httpx.HTTPError as error:
                raise SourceAuditError(f"Source request failed: {error}") from error
        raise SourceAuditError("Source exceeded the redirect limit.")


def audit_recipe_source(source_url: str, client: SafeSourceClient) -> AuditedSource:
    """Extract a recipe and select the first image that passes real pixel checks."""

    html, final_url = client.fetch_html(source_url)
    metadata = extract_recipe_metadata(html, final_url)
    candidates = sorted(
        metadata.image_candidates,
        key=lambda candidate: candidate.declared_area,
        reverse=True,
    )
    if not candidates:
        raise SourceAuditError("Recipe JSON-LD does not provide a public image URL.")

    failures: list[str] = []
    for candidate in candidates:
        try:
            width, height, image_format = client.inspect_image(candidate.url)
            return AuditedSource(metadata, candidate.url, width, height, image_format)
        except SourceAuditError as error:
            failures.append(f"{candidate.url}: {error}")
    raise SourceAuditError("No publisher image passed quality checks. " + " | ".join(failures))


def _validate_public_destination(url: str) -> None:
    """Reject local/private DNS results before the offline curator fetches them."""

    if not is_public_http_url(url):
        raise SourceAuditError("URL is not a public HTTP(S) destination.")
    parsed = urlparse(url)
    try:
        addresses = {
            result[4][0]
            for result in socket.getaddrinfo(
                parsed.hostname,
                parsed.port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        }
    except socket.gaierror as error:
        raise SourceAuditError("Source hostname could not be resolved.") from error
    if not addresses:
        raise SourceAuditError("Source hostname resolved to no addresses.")
    for raw_address in addresses:
        address = ipaddress.ip_address(raw_address)
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        ):
            raise SourceAuditError("Source hostname resolves to a non-public address.")


def _read_bounded(chunks: Iterator[bytes], maximum_bytes: int) -> bytes:
    parts: list[bytes] = []
    total = 0
    for chunk in chunks:
        total += len(chunk)
        if total > maximum_bytes:
            raise SourceAuditError("Source response exceeds the size limit.")
        parts.append(chunk)
    return b"".join(parts)


def _charset_from_content_type(content_type: str) -> str:
    for part in content_type.split(";")[1:]:
        name, separator, value = part.strip().partition("=")
        if separator and name.lower() == "charset" and value.strip():
            return value.strip().strip('"')
    return "utf-8"
