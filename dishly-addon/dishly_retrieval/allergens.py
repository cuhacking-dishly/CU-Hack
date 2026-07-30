"""Conservative allergen and excluded-ingredient detection.

This protects retrieval but is not a medical guarantee. Users must still check
publisher ingredients, product labels, substitutions, and cross-contact risk.
"""

import re

ALLERGEN_ALIASES = {
    "dairy": "dairy",
    "milk": "dairy",
    "lactose": "dairy",
    "egg": "egg",
    "eggs": "egg",
    "fish": "fish",
    # The public goal contract uses "seafood" while the corpus groups finfish
    # under ``fish``. Canonicalizing both to one value makes the safety rule
    # effective instead of leaving a vocabulary gap between services.
    "seafood": "fish",
    "gluten": "gluten",
    "wheat": "gluten",
    "peanut": "peanut",
    "peanuts": "peanut",
    "sesame": "sesame",
    "shellfish": "shellfish",
    "crustacean": "shellfish",
    "crustaceans": "shellfish",
    "soy": "soy",
    "soya": "soy",
    "soybean": "soy",
    "soybeans": "soy",
    "tree nut": "tree_nut",
    "tree nuts": "tree_nut",
    "treenut": "tree_nut",
}


ALLERGEN_INGREDIENT_TERMS = {
    "dairy": {
        "milk", "butter", "cheese", "cream", "yogurt", "yoghurt", "whey",
        "casein", "ghee", "paneer", "parmesan", "feta", "mozzarella",
    },
    "egg": {"egg", "eggs", "mayonnaise", "meringue"},
    "fish": {"fish", "salmon", "tuna", "cod", "anchovy", "anchovies", "sardine", "tilapia"},
    "gluten": {
        "wheat", "all purpose flour", "bread flour", "breadcrumbs", "panko", "bread",
        "pasta", "udon", "couscous", "bulgur", "farro", "barley", "rye", "tortilla",
    },
    "peanut": {"peanut", "peanuts", "peanut butter", "groundnut"},
    "sesame": {"sesame", "tahini"},
    "shellfish": {"shrimp", "prawn", "prawns", "crab", "lobster", "scallop", "mussel", "clam"},
    "soy": {"soy", "soya", "soybean", "tofu", "tempeh", "edamame", "miso", "tamari"},
    "tree_nut": {
        "almond", "almonds", "cashew", "cashews", "walnut", "walnuts", "pecan",
        "pecans", "pistachio", "hazelnut", "macadamia", "brazil nut", "pine nut",
    },
}

# Vegan is a hard eligibility rule in Dishly.  This list is intentionally
# conservative: if a publisher ingredient clearly names an animal product, a
# recipe cannot enter the approved corpus as vegan.  Ambiguous brand names are
# left for the curator rather than guessed here.
VEGAN_FORBIDDEN_INGREDIENT_TERMS = {
    "anchovy", "bacon", "beef", "butter", "casein", "cheese",
    "chicken", "cream", "duck", "egg", "fish", "gelatin", "gelatine",
    "ghee", "goat", "ham", "honey", "lamb", "lard", "mayonnaise", "milk",
    "mutton", "oyster", "paneer", "parmesan", "pork", "prawn",
    "salmon", "sausage", "shellfish", "shrimp", "tuna", "turkey", "whey",
    "yogurt", "yoghurt",
}


def normalize_ingredient_text(value: str) -> str:
    """Create word-boundary-safe lowercase ingredient text."""

    return " ".join(re.sub(r"[^a-z0-9]+", " ", value.lower()).split())


def normalize_allergen(value: str) -> str:
    """Map spelling and plural variants to one canonical allergen label."""

    normalized = normalize_ingredient_text(value).replace("_", " ")
    return ALLERGEN_ALIASES.get(normalized, normalized.replace(" ", "_"))


def ingredient_contains_term(ingredient: str, excluded_term: str) -> bool:
    """Match an excluded ingredient as whole words, avoiding ``nut``/``coconut``."""

    normalized_ingredient = normalize_ingredient_text(ingredient)
    normalized_term = normalize_ingredient_text(excluded_term)
    if not normalized_term:
        return False

    term_variants = {normalized_term}
    if normalized_term.endswith("ies") and len(normalized_term) > 3:
        term_variants.add(f"{normalized_term[:-3]}y")
    elif normalized_term.endswith("s") and len(normalized_term) > 3:
        term_variants.add(normalized_term[:-1])
    else:
        words = normalized_term.split()
        last_word = words[-1]
        plural = f"{last_word[:-1]}ies" if last_word.endswith("y") else f"{last_word}s"
        term_variants.add(" ".join((*words[:-1], plural)))

    return any(
        re.search(rf"(?:^|\s){re.escape(term)}(?:$|\s)", normalized_ingredient) is not None
        for term in term_variants
    )


def detect_allergens(ingredients: tuple[str, ...]) -> frozenset[str]:
    """Derive conservative allergen evidence from exact publisher ingredients."""

    detected: set[str] = set()
    for allergen, terms in ALLERGEN_INGREDIENT_TERMS.items():
        if any(
            ingredient_contains_term(ingredient, term)
            and not _is_plant_based_exception(ingredient, term)
            for ingredient in ingredients
            for term in terms
        ):
            detected.add(allergen)
    return frozenset(detected)


def detect_non_vegan_ingredients(ingredients: tuple[str, ...]) -> frozenset[str]:
    """Return explicit animal-derived terms found in publisher ingredients."""

    return frozenset(
        term
        for term in VEGAN_FORBIDDEN_INGREDIENT_TERMS
        if any(
            ingredient_contains_term(ingredient, term)
            and not _is_plant_based_exception(ingredient, term)
            for ingredient in ingredients
        )
    )


def _is_plant_based_exception(ingredient: str, term: str) -> bool:
    """Prevent names such as peanut butter or oat milk from becoming dairy."""

    normalized = normalize_ingredient_text(ingredient)
    if term == "milk":
        return any(
            phrase in normalized
            for phrase in (
                "almond milk", "cashew milk", "coconut milk", "hemp milk",
                "macadamia milk", "non dairy milk", "oat milk", "plant milk",
                "rice milk", "soy milk",
            )
        )
    if term == "butter":
        return any(
            phrase in normalized
            for phrase in (
                "almond butter", "apple butter", "cashew butter", "cocoa butter",
                "peanut butter", "plant butter", "seed butter", "sun butter",
                "sunflower butter", "vegan butter",
            )
        )
    if term == "cream":
        return any(
            phrase in normalized
            for phrase in ("coconut cream", "cream of tartar", "non dairy cream", "vegan cream")
        )
    if term in {"cheese", "yogurt", "yoghurt"}:
        return any(
            phrase in normalized
            for phrase in ("dairy free", "non dairy", "plant based", "vegan")
        )
    return False


def recipe_matches_exclusion(
    declared_allergens: tuple[str, ...],
    ingredients: tuple[str, ...],
    excluded_allergens: frozenset[str],
    excluded_ingredients: frozenset[str],
) -> bool:
    """Return True if declarations or exact ingredients conflict with a request."""

    normalized_declared = {normalize_allergen(value) for value in declared_allergens}
    detected = set(detect_allergens(ingredients))
    normalized_excluded = {normalize_allergen(value) for value in excluded_allergens}

    if not (normalized_declared | detected).isdisjoint(normalized_excluded):
        return True

    return any(
        ingredient_contains_term(ingredient, excluded)
        for ingredient in ingredients
        for excluded in excluded_ingredients
    )
