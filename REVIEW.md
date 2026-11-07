# Review

- Compare the complete diff against the linked issue and its explicitly scoped increment.
- Verify bounded reads, strict schema validation, path canonicalization, atomic configuration writes and lock cleanup on failures.
- Check that preview changes no files and confirm unregisters without deleting vault content.
- Check non-TTY/agent execution, unknown CLI option refusal and malformed configuration failures.
- Require typecheck, boundary check, tests and package dry-run. Distinguish local evidence from hosted Linux/macOS CI.
- Error messages: a new or changed error, refusal or failure message a person or agent sees names the cause (what failed and why) and the next step (the command, setting or target that fixes it). When secrets, ids or paths must stay out, it names the cause class and how to check it. A message missing either is a finding; Important when it is the only signal of a blocked action (a CLI exit, a refused tool call), otherwise a nit.
- Documentation: a user-facing change updates the README or docs, or refreshes their `docs/verified.json` stamp, in the same PR. Generated README blocks change only through `bun scripts/readme-facts.ts --write`.
- Do not accept claims of MCP, note validation, console, release or live cutover from the registry foundation.
