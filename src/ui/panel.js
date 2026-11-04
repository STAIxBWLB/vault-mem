// vmem console panels (acon api 1). Runs under the shell's strict CSP: data is rendered as text only.
export default (host) => {
  // Every element comes from the console panel kit (host.ui); this file defines no DOM helper of its own.
  const ui = host.ui, h = ui.h;
  const err = (text) => ui.notice(text, "err");
  const btn = (label, onclick, cls = "btn") => h("button", { type: "button", class: cls, onclick, text: label });
  const root = h("div", { class: "vmem" });
  host.mount.append(root);
  let panel = "overview", params = {};
  const go = (p, extra = {}) => host.navigate(host.tool, p, { ...(params.vault ? { vault: params.vault } : {}), ...extra });
  const openNote = (path) => go("note", { path });
  const vaultParam = () => (params.vault ? { vault: params.vault } : {});

  const searchForm = (q) => {
    const input = h("input", { type: "search", name: "q", value: q ?? "", placeholder: "Search notes", "aria-label": "Search notes", class: "vmem-input" });
    return h("form", { class: "vmem-bar", role: "search", onsubmit: (e) => { e.preventDefault(); go("notes", input.value.trim() ? { q: input.value.trim() } : {}); } },
      input, h("button", { type: "submit", class: "btn", text: "Search" }));
  };

  const views = {
    overview(s) {
      const vaults = s.status?.vaults ?? [];
      if (!vaults.length) return [ui.empty("No vault registered", "Run `vmem vaults add <id> <path>` to register one.")];
      return [
        searchForm(""),
        h("div", { class: "vmem-cards" },
          h("section", { class: "card" }, h("h2", { text: "Vaults" }),
            ui.rows(vaults, (v) => ui.row({ title: v.id, sub: `${v.kind} · write ${v.write}${v.health && v.health !== "ok" ? ` · ${v.health}` : ""}`, onOpen: () => go("overview", { vault: v.id }), ...(v.id === s.vault ? { chip: { text: "shown", tone: "ok" } } : {}) }))),
          h("section", { class: "card" }, h("h2", { text: `${s.noteCount ?? 0}${s.noteCountCapped ? "+" : ""} notes · maps` }),
            ui.rows((s.mocs ?? []).slice(0, 8), (m) => ui.row({ title: m.title || m.path, sub: `${m.count} links`, onOpen: () => openNote(m.path) })) ?? ui.empty("No maps yet")),
          h("section", { class: "card" }, h("h2", { text: "Recent log" }),
            ui.rows(s.log ?? [], (r) => ui.row({ title: r.raw ?? `${r.type} ${r.source}${r.dest ? ` → ${r.dest}` : ""}`, ...(r.raw ? {} : { sub: `${r.at} · ${r.project}${r.agent ? " · agent" : ""}` }), onOpen: () => go("log") })) ?? ui.empty("Log is empty"))),
      ];
    },
    notes(s) {
      const list = s.notes ?? [];
      return [searchForm(s.q), s.error ? err(s.error) : null,
        ui.rows(list, (n) => ui.row({ title: n.title || n.path, sub: [n.type, n.domain, n.description].filter(Boolean).join(" · "), onOpen: () => openNote(n.path) }))
          ?? ui.empty(s.q ? "No notes match" : "No notes", s.q ? "Try fewer words; terms are combined with AND." : undefined)];
    },
    note(s) {
      if (s.error) return [err(s.error)];
      const n = s.note;
      if (!n) return [ui.empty("No note selected", "Open a note from Search or the palette.")];
      const fm = n.frontmatter ?? {};
      const moveInput = h("input", { type: "text", name: "to", class: "vmem-input", "aria-label": "New stem", placeholder: "new-stem" });
      const orgs = s.orgVaults ?? [];
      const orgSelect = orgs.length ? h("select", { name: "org", class: "vmem-input", "aria-label": "Org vault" }, ...orgs.map((o) => h("option", { value: o, text: o }))) : null;
      const out = s.links?.out ?? [], back = s.links?.in ?? [], dead = s.links?.dead ?? [];
      const links = [...out.map((l) => ({ path: l.resolved, label: `→ ${l.resolved}` })), ...back.map((l) => ({ path: l.source, label: `← ${l.source}` })), ...dead.map((l) => ({ label: `✕ ${l.target}` }))];
      const actions = [
        btn("Delete…", () => host.action({ action: "delete", path: n.path, ...vaultParam() }), "btn danger"),
        h("form", { class: "vmem-inline", onsubmit: (e) => { e.preventDefault(); if (moveInput.value.trim()) host.action({ action: "move", from: n.path, to: moveInput.value.trim(), ...vaultParam() }); } },
          moveInput, h("button", { type: "submit", class: "btn", text: "Move…" })),
      ];
      if (orgSelect) {
        const topics = h("input", { type: "text", name: "orgTopics", class: "vmem-input", "aria-label": "Org topics (comma separated, optional)", placeholder: "org topics (optional)" });
        const again = h("input", { type: "checkbox", name: "again", "aria-label": "Promote again to another org" });
        actions.push(h("form", { class: "vmem-inline", onsubmit: (e) => { e.preventDefault(); host.action({ action: "promote", path: n.path, to: orgSelect.value, ...(topics.value.trim() ? { topics: topics.value.trim() } : {}), ...(again.checked ? { again: true } : {}) }); } },
          orgSelect, topics, h("label", { class: "vmem-check" }, again, h("span", { text: "again" })), h("button", { type: "submit", class: "btn", text: "Promote to org…" })));
      }
      return [ui.detail({
        kind: fm.type || "note", title: fm.title || n.path,
        ...(fm.status ? { state: { text: fm.status, ...(fm.status === "superseded" ? { tone: "warn" } : {}) } } : {}),
        actions, ...(fm.description ? { summary: fm.description } : {}),
        sections: [
          { title: "Body", open: true, body: h("div", {}, h("pre", { class: "vmem-body", text: n.body ?? "" }), n.truncated ? err("Truncated; open the file for the rest.") : null) },
          { title: `Links (${out.length} out, ${back.length} in${dead.length ? `, ${dead.length} dead` : ""})`,
            body: ui.rows(links, (l) => ui.row({ title: l.label, ...(l.path ? { onOpen: () => openNote(l.path) } : {}) })) ?? ui.empty("No links") },
        ],
        footer: [`${n.path} · sha256 ${String(n.sha256 ?? "").slice(0, 12)}`],
      })];
    },
    promote(s) {
      const projects = s.projects ?? [];
      const all = projects.flatMap((p) => p.candidates);
      const picked = all.find((c) => c.id === s.selected);
      const form = picked ? h("section", { class: "card vmem-form" }, h("h2", { text: `Promote: ${picked.title || picked.kind}` }),
        ui.form([
          { name: "domain", label: "domain (required)", required: true },
          { name: "topics", label: "topics, comma separated (required)", required: true },
          { name: "type", label: "type (optional)" },
          { name: "description", label: "description (optional)" },
          { name: "stem", label: "file stem (needed when the title has no ASCII letters)" },
        ], { label: "Preview promotion…", primary: true }, (values) => {
          const meta = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
          host.action({ action: "promote-from-amem", id: picked.id, project: picked.project, ...meta, ...vaultParam() });
        })) : null;
      return [s.unavailable ? err(s.unavailable) : null, form,
        ui.rows(all, (c) => ui.row({ title: c.title || c.kind, sub: `${c.kind} · ${c.project} · ${new Date(c.at).toLocaleString()}`, onOpen: () => go("promote", { id: c.id, project: c.project }),
          ...(s.selected === c.id ? { chip: { text: "selected", tone: "ok" } } : { verbs: [btn("Select", () => go("promote", { id: c.id, project: c.project }))] }) }))
          ?? ui.empty("No promotion candidates", "Durable agent memories appear here when agent-mem marks them for the vault.")];
    },
    lint(s) {
      const f = s.findings ?? [];
      return [h("p", { class: "vmem-sub", text: s.summary ?? "" }),
        ui.rows(f, (x) => ui.row({ title: x.message, sub: `${x.code}${x.path ? ` · ${x.path}` : ""}`, ...(x.path ? { onOpen: () => openNote(x.path) } : {}), chip: { text: x.severity, tone: x.severity === "error" ? "err" : "warn" } }))
          ?? ui.empty("No lint findings", "The vault passes every check.")];
    },
    log(s) {
      const r = s.rows ?? [];
      return [s.error ? err(s.error) : null,
        ui.rows(r, (x) => {
          const p = x.dest ?? x.source;
          return ui.row({ title: x.raw ?? `${x.type}  ${x.source}${x.dest ? ` → ${x.dest}` : ""}`, sub: x.raw ? "unparsed line" : `${x.at} · ${x.project} · ${x.note}${x.agent ? " · agent" : ""}`,
            ...(typeof p === "string" && p.startsWith("notes/") ? { onOpen: () => openNote(p) } : {}) });
        }) ?? ui.empty("Log is empty")];
    },
  };

  let last = "";
  host.onSnapshot((snap) => {
    const sig = JSON.stringify([panel, snap]);
    if (sig === last) return; // unchanged poll: keep focus and scroll
    last = sig;
    // A poll re-renders the view: carry every typed value and the focus over by field name.
    // Rule: every form control in this file has a stable name, or its state is lost on the next poll.
    const values = new Map([...root.querySelectorAll("input[name], select[name]")].map((el) => [el.name, el.type === "checkbox" ? el.checked : el.value]));
    const focused = root.contains(document.activeElement) ? document.activeElement.getAttribute("name") : null;
    root.replaceChildren(...(views[panel]?.(snap) ?? [ui.empty("Unknown panel")]).filter(Boolean));
    for (const el of root.querySelectorAll("input[name], select[name]")) if (values.has(el.name)) el[el.type === "checkbox" ? "checked" : "value"] = values.get(el.name);
    if (focused) root.querySelector(`[name="${focused}"]`)?.focus();
  });
  return {
    show(id, p = {}) { panel = id; params = p; last = ""; root.replaceChildren(); },
    hide() {},
    destroy() { root.remove(); },
  };
};
