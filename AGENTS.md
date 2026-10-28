# vault-mem

- Implement the accepted issue contract; use branches and PRs. Keep note contents and credentials out of fixtures.
- Source is in `src/`, the executable bootstrap in `bin/`, checks in `scripts/`, tests in `test/`.
- Use strict TypeScript, `.ts` imports and `noUncheckedIndexedAccess`. Keep runtime imports to builtins and the exact first-party dependency pin. Import agent-mem platform only through `src/platform.ts` and its root only through `src/amem/seam.ts`.
- Run `bun install --frozen-lockfile`, then `bun run check`. Passing output includes `boundary: ok`, all tests passing and a successful package dry-run. The check exits nonzero on failure.
- Treat registry removal as unregistering only. Preserve all vault files. Do not add agent-environment refusal or TTY mutation requirements.
- Keep unimplemented capabilities explicit in README; export commands and interfaces only when implemented.
- Use conventional English commits without coauthor trailers unless requested.
