# AGENTS.md

Guidance for coding agents working in this repository.

## TypeScript-First Upstream Synchronization

- Treat the Python `dagent` repository as the behavioral reference, not as a source to translate
  line by line.
- Preserve the intent and observable contract of upstream releases while expressing them with
  TypeScript idioms: discriminated unions, readonly data, generics, Zod boundary schemas,
  `AsyncIterable`, explicit resource ownership, and ESM package boundaries.
- Do not reproduce Python class hierarchies, decorators, Pydantic implementation details, naming,
  or module layout when a smaller and clearer TypeScript design serves the same contract.
- Record intentional language-specific differences in tests and user-facing migration docs.

## Architecture And Code Quality

- Keep layers explicit: contracts own cross-boundary data, domain modules own pure validation and
  transitions, runtime modules own execution, the SDK entrypoint owns orchestration, the app owns
  persistence and HTTP concerns, and the Web app consumes only public contracts.
- Extend existing discriminated unions, validators, builders, and execution paths instead of
  creating parallel feature-specific implementations.
- Extract a shared abstraction when it represents one stable concept used in multiple places.
  Avoid both duplicated logic and speculative abstraction without a concrete reuse case.
- Design public contracts for exhaustive handling and future extension. New variants must be
  propagated through parsing, validation, execution, persistence, API projection, UI rendering,
  tests, and documentation as applicable.
- Prefer small composable functions, immutable values, precise names, and explicit failure modes.
  Avoid catch-all fallbacks, hidden compatibility shims, mutable global state, and untyped
  cross-layer objects.
- Keep implementations mature and maintainable: ownership should be obvious, dependencies should
  point inward toward stable contracts, and each rule should have one authoritative implementation.

## Public Contracts And Compatibility

- Treat exported SDK types, package entrypoints, serialized DAG/checkpoint/event shapes,
  capability ids, configuration, and documented workflows as released contracts.
- Preserve backward compatibility unless an upstream breaking change or an explicit local design
  decision requires otherwise. Make deliberate breaking changes visible in migration notes and
  tests; do not add aliases or conversion layers by default.
- Parse and validate data once at each trust boundary. Internal code should operate on validated,
  typed values and should not repeatedly reinterpret raw input.
- Keep generated or model-proposed execution declarative. Never evaluate arbitrary model-produced
  JavaScript or TypeScript as part of DAG execution.

## Verification And Documentation

- When behavior changes, update focused unit/contract tests, bilingual English and Simplified
  Chinese documentation, examples, changelog, and version metadata in the same change.
- Start with the narrowest meaningful checks, then run `pnpm verify` for changes to shared public
  contracts or runtime behavior.
- Keep the worktree clean of generated build artifacts and preserve unrelated user changes.
