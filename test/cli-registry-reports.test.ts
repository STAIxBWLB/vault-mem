import { expect, test } from "bun:test";
import { renderDoctor, renderSettings, renderSetup, renderStatus, type StatusResult } from "../src/cli-output.ts";
import { stripTerminal, width } from "../src/text-output.ts";

const options = { columns: 80, ascii: true, color: false };
const fixture: StatusResult = {
  home: "/fixture/home", source: "VMEM_HOME", version: "1.0.0", healthy: false,
  vaults: [{ id: "mine", path: "/fixture/vault", kind: "personal", write: "mcp", pii: "allow", healthy: true,
    checks: { remote: { ok: false, issue: "origin does not match; nothing was fetched or pushed" } },
    tidy: { pending: { keys: 1 }, notes: 1, unparsable: [], hint: "" } }], specs: [],
};

test("registry report goldens use ASCII markers and package colors at 80 columns", () => {
  const expected = [
    " vmem doctor", "", "> Findings", "  x  mine remote: origin does not match",
    "    -> git -C /fixture/vault remote -v", "  !  mine tidy: 1 note to migrate (keys 1)",
    "    -> vmem tidy mine --all", "  ok mine path: /fixture/vault", "", "> Home",
    "  Version:    1.0.0", "  Home:       /fixture/home", "  Source:     VMEM_HOME",
    "  agent-mem:  (unset)", "  Host API:   (unset)", "", "x 1 failed  ! 1 warning  ok 1 ok",
  ].join("\n");
  expect(renderDoctor(fixture, options)).toBe(expected);
  const reports = [renderDoctor(fixture, options), renderStatus(fixture, options), renderSettings({ home: "/fixture/home", vault: "mine", defaultVault: "mine", defaultVaultExplicit: false, write: "mcp", piiPatterns: [], graphResolution: 1, enrichmentEnabled: false }, options),
    renderSetup({ mode: "dry-run", applied: false, entry: { command: "/fixture/bun", args: ["mcp"] }, actions: [{ target: "qwen", file: "/fixture/config", change: "none" }], skills: [{ target: "qwen", reason: "links to /fixture/foreign; use vmem skills export <dir>" }], notes: [] }, options)];
  const colored = [renderDoctor(fixture, { ...options, color: true }), renderStatus(fixture, { ...options, color: true }), renderSettings({ home: "/fixture/home", vault: "mine", defaultVault: "mine", defaultVaultExplicit: false, write: "mcp", piiPatterns: [], graphResolution: 1, enrichmentEnabled: false }, { ...options, color: true }),
    renderSetup({ mode: "dry-run", applied: false, entry: { command: "/fixture/bun", args: ["mcp"] }, actions: [{ target: "qwen", file: "/fixture/config", change: "none" }], skills: [{ target: "qwen", reason: "links to /fixture/foreign; use vmem skills export <dir>" }], notes: [] }, { ...options, color: true })];
  for (let i = 0; i < reports.length; i++) {
    expect(stripTerminal(colored[i]!)).toBe(reports[i]!);
    expect(colored[i]).not.toBe(reports[i]);
    for (const line of reports[i]!.split("\n")) expect(width(line)).toBeLessThanOrEqual(80);
    expect(reports[i]).not.toContain("`");
    expect(reports[i]).not.toContain("(s)");
  }
  expect(reports[3]).toContain("none: links to /fixture/foreign");
  expect(reports[3]).not.toContain("refused");
});
