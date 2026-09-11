"""Process-local bootstrap for the candidate-v19 Runner 1.15 overlay."""

try:
    from exact_running_adoption import install

    install()
except Exception as exc:
    # CPython's site module only reports and suppresses ordinary exceptions
    # from sitecustomize.  SystemExit is deliberately used to make installation
    # or version drift fatal before autodl-direct can enter its generic path.
    raise SystemExit(f"candidate-v19 exact-running overlay failed: {exc}") from exc
