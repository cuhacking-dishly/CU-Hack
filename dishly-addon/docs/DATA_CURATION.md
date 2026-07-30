# Source-backed recipe curation

Dishly serves only records that pass the complete source audit. `data/source_seeds.json` contains manually reviewed source URLs, cuisine/meal labels, vegan decisions, descriptions, and optional nutrition fallbacks. It is the human-review layer. `data/recipes.json` is generated output.

## What ingestion copies from the exact recipe page

- recipe title and full ingredient strings;
- publisher/author identity and canonical source URL;
- publisher-hosted image candidate;
- nutrition, yield, and total time when Schema.org provides them.

The chosen image is fetched and decoded. Declared HTML dimensions alone are not trusted. Portrait, square, and landscape food photography are accepted when the short side is at least 500 px and the image has at least 400,000 pixels.

## What is reviewed by Dishly

- cuisine and meal taxonomy;
- vegan yes/no classification;
- concise description;
- fallback macro/time estimates when the publisher omits data;
- declared allergen set.

The validator derives allergen and non-vegan evidence from ingredients. A record is rejected if its allergen declaration omits detected evidence or if a recipe marked vegan contains animal-derived evidence. Plant milks and nut butters are handled as plant ingredients while still retaining their relevant nut/soy allergen.

## Safe refresh workflow

1. Add or update a unique exact recipe URL in `source_seeds.json`.
2. Confirm the page has a good dish photo and Recipe JSON-LD.
3. Run `python -m dishly_retrieval ingest`.
4. Read `source_audit_report.json`. Any failure means the serving corpus was not replaced.
5. Run `python -m dishly_retrieval validate`.
6. Run `python -m dishly_retrieval build-index` because corpus content changed.
7. Run the complete verification suite.

Generated embeddings are not committed because they are model- and machine-derived. The source seeds, approved corpus, schema, and audit result are committed so provenance is reviewable.
