// vmem console panels (acon api 1). Runs under the shell's strict CSP: data is rendered as text only.
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") el.textContent = String(v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  el.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  return el;
};
const empty = (title, hint) => h("div", { class: "empty" }, h("strong", { text: title }), hint ? h("span", { text: hint }) : null);
const err = (text) => h("p", { class: "notice", role: "alert", text });
const rows = (items, row) => (items.length ? h("ul", { class: "rows" }, items.map(row)) : null);
const row = (title, sub, onOpen, ...verbs) => h("li", { class: "row" },
  h("button", { type: "button", class: "row-main", onclick: onOpen },
    h("span", { class: "row-text" }, h("span", { class: "row-title", text: title }), sub ? h("span", { class: "row-sub", text: sub }) : null)),
  verbs.length ? h("span", { class: "row-verbs" }, verbs) : null);
const btn = (label, onclick, cls = "btn") => h("button", { type: "button", class: cls, onclick, text: label });
const chip = (text, tone) => h("span", { class: `chip${tone ? ` ${tone}` : ""}`, text });

export default (host) => {
  const root = h("div", { class: "vmem" });
  host.mount.append(root);
  let panel = "overview", params = {};
  const go = (p, extra = {}) => host.navigate(host.tool, p, { ...(params.vault ? { vault: params.vault } : {}), ...extra });
  const openNote = (path) => go("note", { path });

  const searchForm = (q) => {
    const input = h("input", { type: "search", name: "q", value: q ?? "", placeholder: "Search notes", "aria-label": "Search notes", class: "vmem-input" });
    return h("form", { class: "vmem-bar", role: "search", onsubmit: (e) => { e.preventDefault(); go("notes", input.value.trim() ? { q: input.value.trim() } : {}); } },
      input, h("button", { type: "submit", class: "btn", text: "Search" }));
  };

  const views = {
    overview(s) {
      const vaults = s.status?.vaults ?? [];
      if (!vaults.length) return [empty("No vault registered", "Run `vmem vaults add <id> <path>` to register one.")];
      return [
        searchForm(""),
        h("div", { class: "cards" },
          h("section", { class: "card" }, h("h2", { text: "Vaults" }),
            rows(vaults, (v) => row(v.id, `${v.kind} · write ${v.write}${v.health && v.health !== "ok" ? ` · ${v.health}` : ""}`, () => go("overview", { vault: v.id }), v.id === s.vault ? chip("shown", "accent") : null))),
          h("section", { class: "card" }, h("h2", { text: `${s.noteCount ?? 0}${s.noteCountCapped ? "+" : ""} notes · maps` }),
            rows((s.mocs ?? []).slice(0, 8), (m) => row(m.title || m.path, `${m.count} links`, () => openNote(m.path))) ?? empty("No maps yet")),
          h("section", { class: "card" }, h("h2", { text: "Recent log" }),
            rows(s.log ?? [], (r) => row(r.raw ?? `${r.type} ${r.source}${r.dest ? ` → ${r.dest}` : ""}`, r.raw ? "" : `${r.at} · ${r.project}${r.agent ? " · agent" : ""}`, () => go("log"))) ?? empty("Log is empty"))),
      ];
    },
    notes(s) {
      const list = s.notes ?? [];
      return [searchForm(s.q), s.error ? err(s.error) : null,
        rows(list, (n) => row(n.title || n.path, [n.type, n.domain, n.description].filter(Boolean).join(" · "), () => openNote(n.path)))
          ?? empty(s.q ? "No notes match" : "No notes", s.q ? "Try fewer words; terms are combined with AND." : null)];
    },
    note(s) {
      if (s.error) return [err(s.error)];
      const n = s.note;
      if (!n) return [empty("No note selected", "Open a note from Search or the palette.")];
      const fm = n.frontmatter ?? {};
      const title = fm.title || n.path;
      const moveInput = h("input", { type: "text", name: "to", class: "vmem-input", "aria-label": "New stem", placeholder: "new-stem" });
      const orgs = s.orgVaults ?? [];
      const orgSelect = orgs.length ? h("select", { class: "vmem-input", "aria-label": "Org vault" }, orgs.map((o) => h("option", { value: o, text: o }))) : null;
      const out = s.links?.out ?? [], back = s.links?.in ?? [], dead = s.links?.dead ?? [];
      return [
        h("header", { class: "vmem-head" }, chip(fm.type || "note"), h("h2", { text: title }), fm.status ? chip(fm.status, fm.status === "superseded" ? "warn" : null) : null),
        fm.description ? h("p", { class: "vmem-sub", text: fm.description }) : null,
        h("div", { class: "vmem-bar" },
          btn("Delete…", () => host.action({ action: "delete", path: n.path, ...(params.vault ? { vault: params.vault } : {}) }), "btn danger"),
          h("form", { class: "vmem-inline", onsubmit: (e) => { e.preventDefault(); if (moveInput.value.trim()) host.action({ action: "move", from: n.path, to: moveInput.value.trim(), ...(params.vault ? { vault: params.vault } : {}) }); } },
            moveInput, h("button", { type: "submit", class: "btn", text: "Move…" })),
          orgSelect ? (() => {
            const topics = h("input", { type: "text", name: "orgTopics", class: "vmem-input", "aria-label": "Org topics (comma separated, optional)", placeholder: "org topics (optional)" });
            const again = h("input", { type: "checkbox", name: "again", "aria-label": "Promote again to another org" });
            return h("form", { class: "vmem-inline", onsubmit: (e) => { e.preventDefault(); host.action({ action: "promote", path: n.path, to: orgSelect.value, ...(topics.value.trim() ? { topics: topics.value.trim() } : {}), ...(again.checked ? { again: true } : {}) }); } },
              orgSelect, topics, h("label", { class: "vmem-check" }, again, h("span", { text: "again" })), h("button", { type: "submit", class: "btn", text: "Promote to org…" }));
          })() : null),
        h("details", { open: true }, h("summary", { text: "Body" }), h("pre", { class: "vmem-body", text: n.body ?? "" }), n.truncated ? err("Truncated; open the file for the rest.") : null),
        h("details", {}, h("summary", { text: `Links (${out.length} out, ${back.length} in${dead.length ? `, ${dead.length} dead` : ""})` }),
          rows([...out.map((l) => ({ path: l.resolved, label: `→ ${l.resolved}` })), ...back.map((l) => ({ path: l.source, label: `← ${l.source}` })), ...dead.map((l) => ({ label: `✕ ${l.target}` }))],
            (l) => row(l.label, "", () => l.path && openNote(l.path))) ?? empty("No links")),
        h("p", { class: "vmem-mono", text: `${n.path} · sha256 ${String(n.sha256 ?? "").slice(0, 12)}` }),
      ];
    },
    promote(s) {
      const projects = s.projects ?? [];
      const all = projects.flatMap((p) => p.candidates);
      const picked = all.find((c) => c.id === s.selected);
      const field = (name, label, required) => h("input", { type: "text", name, class: "vmem-input", "aria-label": label, placeholder: label, required });
      const form = picked ? (() => {
        const domain = field("domain", "domain (required)", true), topics = field("topics", "topics, comma separated (required)", true), type = field("type", "type (optional)"), description = field("description", "description (optional)"), stem = field("stem", "file stem (needed when the title has no ASCII letters)");
        return h("form", { class: "card vmem-form", onsubmit: (e) => {
          e.preventDefault();
          const meta = Object.fromEntries([["domain", domain], ["topics", topics], ["type", type], ["description", description], ["stem", stem]].filter(([, el]) => el.value.trim()).map(([k, el]) => [k, el.value.trim()]));
          host.action({ action: "promote-from-amem", id: picked.id, project: picked.project, ...meta, ...(params.vault ? { vault: params.vault } : {}) });
        } }, h("h2", { text: `Promote: ${picked.title || picked.kind}` }), domain, topics, type, description, stem, h("button", { type: "submit", class: "btn primary", text: "Preview promotion…" }));
      })() : null;
      return [s.unavailable ? err(s.unavailable) : null, form,
        rows(all, (c) => row(c.title || c.kind, `${c.kind} · ${c.project} · ${new Date(c.at).toLocaleString()}`, () => go("promote", { id: c.id, project: c.project }),
          s.selected === c.id ? chip("selected", "accent") : btn("Select", () => go("promote", { id: c.id, project: c.project }))))
          ?? empty("No promotion candidates", "Durable agent memories appear here when agent-mem marks them for the vault.")];
    },
    lint(s) {
      const f = s.findings ?? [];
      return [h("p", { class: "vmem-sub", text: s.summary ?? "" }),
        rows(f, (x) => row(x.message, `${x.code}${x.path ? ` · ${x.path}` : ""}`, () => x.path && openNote(x.path), chip(x.severity, x.severity === "error" ? "err" : "warn")))
          ?? empty("No lint findings", "The vault passes every check.")];
    },
    log(s) {
      const r = s.rows ?? [];
      return [s.error ? err(s.error) : null,
        rows(r, (x) => row(x.raw ?? `${x.type}  ${x.source}${x.dest ? ` → ${x.dest}` : ""}`, x.raw ? "unparsed line" : `${x.at} · ${x.project} · ${x.note}${x.agent ? " · agent" : ""}`,
          () => { const p = x.dest ?? x.source; if (typeof p === "string" && p.startsWith("notes/")) openNote(p); })) ?? empty("Log is empty")];
    },
  };

  let last = "";
  host.onSnapshot((snap) => {
    const sig = JSON.stringify([panel, snap]);
    if (sig === last) return; // unchanged poll: keep focus and scroll
    last = sig;
    // A poll re-renders the view: carry every typed value and the focus over by field name.
    const values = new Map([...root.querySelectorAll("input[name], select[name]")].map((el) => [el.name, el.type === "checkbox" ? el.checked : el.value]));
    const focused = root.contains(document.activeElement) ? document.activeElement.getAttribute("name") : null;
    root.replaceChildren(...(views[panel]?.(snap) ?? [empty("Unknown panel")]).filter(Boolean));
    for (const el of root.querySelectorAll("input[name], select[name]")) if (values.has(el.name)) el[el.type === "checkbox" ? "checked" : "value"] = values.get(el.name);
    if (focused) root.querySelector(`[name="${focused}"]`)?.focus();
  });
  return {
    show(id, p = {}) { panel = id; params = p; last = ""; root.replaceChildren(); },
    hide() {},
    destroy() { root.remove(); },
  };
};
