import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
// Usage: bun scripts/check-boundary.ts [project-root]; defaults to the current directory.
const root = process.argv[2] ?? ".";
import { builtinModules } from "node:module";
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const errors: string[] = [];
function inspect(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) { inspect(file); continue; }
    if (!file.endsWith(".ts")) continue;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      let spec: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) spec = node.arguments[0];
      if (spec) {
        if (!ts.isStringLiteral(spec)) errors.push(`${file}: nonliteral import`);
        else {
          const name = spec.text;
          const allowed = name.startsWith(".") || builtins.has(name) || name.startsWith("bun:") ||
            (name === "@staix/agent-mem/platform" && relative(root, file) === "src/platform.ts") ||
            (name === "@staix/agent-mem" && relative(root, file) === "src/amem/seam.ts") ||
            // The console contract is types only; the import is erased at runtime.
            (name === "@staix/agent-console/contract" && ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true);
          if (!allowed) errors.push(`${file}: forbidden dependency ${name}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
inspect(join(root, "src"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (JSON.stringify(pkg.dependencies) !== JSON.stringify({ "@staix/agent-mem": "0.11.0" })) errors.push("runtime dependency must be exactly @staix/agent-mem 0.11.0");
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("boundary: ok");
