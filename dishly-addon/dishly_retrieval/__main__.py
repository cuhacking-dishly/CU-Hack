"""Allow ``python -m dishly_retrieval`` to delegate to the CLI entry point."""

from .cli import main

if __name__ == "__main__":
    # This guard runs only when Python launches this module directly.
    raise SystemExit(main())
