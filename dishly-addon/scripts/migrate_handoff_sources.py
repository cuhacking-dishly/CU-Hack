"""One-time deterministic migration of Appendix B into source seed records."""

import argparse
import json
from pathlib import Path

START_MARKER = "BEGIN RECIPE JSON"
END_MARKER = "END RECIPE JSON"


def extract_json_array(text: str) -> list[dict[str, object]]:
    """Extract the single JSON array delimited by the handoff markers."""

    start_line = next(
        (index for index, line in enumerate(text.splitlines()) if START_MARKER in line),
        None,
    )
    end_line = next(
        (index for index, line in enumerate(text.splitlines()) if END_MARKER in line),
        None,
    )
    if start_line is None or end_line is None or end_line <= start_line:
        raise ValueError("Handoff recipe markers were not found in the expected order.")
    payload = "\n".join(text.splitlines()[start_line + 1 : end_line]).strip()
    parsed = json.loads(payload)
    if not isinstance(parsed, list) or not all(isinstance(item, dict) for item in parsed):
        raise ValueError("Handoff recipe appendix must be an array of objects.")
    return parsed


def migrate(input_path: Path, output_path: Path) -> tuple[int, int]:
    """Deduplicate by source URL, assign stable local IDs, and save seed JSON."""

    raw_records = extract_json_array(input_path.read_text(encoding="utf-8"))
    seen_urls: set[str] = set()
    sources: list[dict[str, object]] = []
    for record in raw_records:
        source_url = record.get("source_url")
        if not isinstance(source_url, str) or not source_url:
            raise ValueError("Every handoff record needs source_url.")
        if source_url in seen_urls:
            continue
        seen_urls.add(source_url)
        sources.append(
            {
                "id": str(len(sources) + 1),
                "title_hint": record.get("name"),
                "cuisine": record.get("cuisine"),
                "meal_type": record.get("meal_type"),
                "protein_grams": record.get("protein_grams"),
                "calories": record.get("calories"),
                "carbs_grams": None,
                "fat_grams": None,
                "time_minutes": record.get("time_minutes"),
                "vegan": record.get("vegan"),
                "allergens": record.get("allergens", []),
                "description": record.get("description"),
                "source_url": source_url,
            }
        )
    document = {"schema_version": 1, "sources": sources}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return len(raw_records), len(sources)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    raw_count, unique_count = migrate(args.input, args.output)
    print(f"Migrated {unique_count} unique sources from {raw_count} records.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
