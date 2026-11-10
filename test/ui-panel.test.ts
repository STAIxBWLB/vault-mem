import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createPromoteSnapshot, nextSnapshotCursor } from "../src/ui/snapshot-cache.ts";

// Exercise the shipped JavaScript module with a minimal panel-kit host. No browser or real home is used.
class Element {
  children: Element[] = [];
  constructor(readonly kind: string, readonly props: Record<string, unknown> = {}) {}
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  querySelectorAll() { return []; }
  contains() { return false; }
  remove() {}
}

test("the panel restores a full unchanged view on repeated routes, even when the shell suppresses unchanged replies", async () => {
  const source = readFileSync(new URL("../src/ui/panel.js", import.meta.url), "utf8");
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const mount = new Element("mount");
  let receive!: (data: Record<string, unknown>) => void;
  const h = (kind: string, props: Record<string, unknown>, ...nodes: Element[]) => { const el = new Element(kind, props); el.append(...nodes); return el; };
  const host = { tool: "vmem", mount, onSnapshot(fn: typeof receive) { receive = fn; },
    ui: { h, rows: (rows: unknown[], render: (row: unknown) => Element) => rows.length ? h("rows", {}, ...rows.map(render)) : null,
      row: (props: Record<string, unknown>) => h("row", props), button: (label: string) => h("button", { label }),
      notice: (text: string) => h("notice", { text }), empty: (title: string) => h("empty", { title }), form: () => h("form", {}) },
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: { activeElement: null }, configurable: true });
  try {
    const panel = mod.default(host), root = mount.children[0]!;
    const snapshot = { projects: [{ project: "synthetic", candidates: [{ id: "fixture", project: "synthetic", kind: "decision", title: "Synthetic candidate", at: "2026-11-10T00:00:00Z" }] }], selected: null, cursor: 1 };
    panel.show("promote"); receive(snapshot);
    expect(root.children.length).toBeGreaterThan(0);
    for (const params of [{}, { id: "fixture", project: "synthetic" }]) {
      panel.show("promote", params); receive({ ...snapshot, selected: params.id ?? null });
      panel.hide(); panel.show("promote", params);
      expect(root.children.length).toBeGreaterThan(0); // no listener call from an unchanged-suppressing shell
      const restored = root.children;
      receive({ changed: false, cursor: 1 });
      expect(root.children).toBe(restored); // older shells may still forward changed:false
      expect(JSON.stringify(root.children)).toContain("Synthetic candidate");
    }
    // Model a shell that retains numeric error cursors and suppresses unchanged replies.
    let time = 0, fail = false;
    const cache = createPromoteSnapshot(() => 1, async () => {
      if (fail) throw new Error("Synthetic unavailable"); return { projects: snapshot.projects };
    }, () => time);
    const poll = async (after: unknown) => {
      let reply;
      try { reply = await cache.snapshot({ after }); }
      catch { reply = { projects: [], unavailable: "Synthetic unavailable", cursor: nextSnapshotCursor() }; }
      if (reply.changed !== false) receive(reply);
      return reply;
    };
    panel.show("promote");
    const good = await poll(0);
    fail = true; time = 60_000;
    const unavailable = await poll(good.cursor);
    expect(JSON.stringify(root.children)).toContain("Synthetic unavailable");
    fail = false;
    const recovered = await poll(unavailable.cursor);
    expect(recovered.changed).toBeUndefined();
    expect(JSON.stringify(root.children)).toContain("Synthetic candidate");
    expect(JSON.stringify(root.children)).not.toContain("Synthetic unavailable");
    await poll(recovered.cursor);
    expect(JSON.stringify(root.children)).toContain("Synthetic candidate");
    // A stale page token resets to page 0, so there is no earlier page: the panel hides "First page".
    panel.show("promote", { page: "9:0" });
    receive({ ...snapshot, cursor: 5, page: "1:0", nextPage: "1:1", reset: true });
    expect(JSON.stringify(root.children)).not.toContain("First page");
    expect(JSON.stringify(root.children)).toContain("Next page");
    // A live page token keeps the way back to the first page.
    panel.show("promote", { page: "1:1" });
    receive({ ...snapshot, cursor: 6, page: "1:1", nextPage: "1:2" });
    expect(JSON.stringify(root.children)).toContain("First page");
    panel.show("notes", { q: "another-view" });
    receive({ changed: false, cursor: 1 });
    expect(root.children).toHaveLength(0); // never reuse a snapshot belonging to different params
    panel.destroy();
  } finally {
    if (saved) Object.defineProperty(globalThis, "document", saved); else Reflect.deleteProperty(globalThis, "document");
  }
});
