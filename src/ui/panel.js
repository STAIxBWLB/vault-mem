// vmem console panels (acon api 1). Runs under the shell's strict CSP: data is rendered as text only.
export default (host) => {
  // Every element comes from the console panel kit (host.ui); this file defines no DOM helper of its own.
  const ui = host.ui, h = ui.h;
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

  /** Journal coverage warnings computed by the provider (`warnings`); anything short of a fully verified journal shows. */
  const coverageNotices = (warnings) => (warnings ?? []).map((w) => ui.notice(w.message, w.tone));
  // A continuation is bound to the query that produced it, so every query param travels with it.
  const assertionQuery = () => Object.fromEntries(["subject", "relation", "at", "asOf", "history", "limit"].filter((k) => params[k] !== undefined && params[k] !== "").map((k) => [k, params[k]]));

  const views = {
    graph(s) {
      if (s.error) return [ui.notice(s.error, "err"), ...(params.page ? [h("div", { class: "vmem-bar" }, ui.button("First page", () => go("graph")))] : [])];
      const graph = s.graph ?? {}, totals = s.totals ?? {};
      return [h("section", { class: "card" }, h("h2", { text: `Graph · ${s.vault}` }),
        h("p", { text: `Revision: ${s.revision}` }),
        h("p", { text: `Nodes: ${totals.nodes} · edges: ${totals.edges} · placeholders: ${totals.placeholders} · omitted: ${totals.placeholdersOmitted}` }),
        h("p", { text: `${graph.partitioner} · resolution ${graph.resolution} · modularity ${graph.modularity} · iterations ${graph.iterations}/${graph.max_iterations}` }),
        h("p", { text: `${s.kind} · offset ${s.offset} · ${s.count} of ${totals[s.kind]} rows · ${s.next !== null ? "more pages follow" : "last page"}` })),
        h("div", { class: "vmem-bar" }, ...(params.page ? [ui.button("First page", () => go("graph"))] : []), ...(s.next ? [ui.button("Next page", () => go("graph", { page: s.next }))] : []))];
    },
    settings(s) {
      if (s.error) return [ui.notice(s.error, "err")];
      const defaultVault = h("input", { type: "text", name: "defaultVault", value: s.defaultVault ?? "", class: "vmem-input", "aria-label": "Default vault" });
      const write = h("select", { name: "write", class: "vmem-input", "aria-label": "Write mode" }, ...["none", "cli", "mcp"].map(v => h("option", { value: v, text: v, ...(v === s.write ? { selected: true } : {}) })));
      const patterns = h("input", { type: "text", name: "piiPatterns", value: JSON.stringify(s.piiPatterns ?? []), class: "vmem-input", "aria-label": "PII patterns as JSON array", oninput: (e) => e.target.setCustomValidity("") });
      const resolution = h("input", { type: "number", name: "resolution", value: String(s.graphResolution), min: "0.01", max: "100", step: "any", class: "vmem-input", "aria-label": "Graph resolution" });
      const enrichment = h("input", { type: "checkbox", name: "enrichmentEnabled", checked: s.enrichmentEnabled, "aria-label": "Enable enrichment" });
      return [h("p", { text: `Settings for ${s.vault}${s.defaultVaultExplicit ? "" : " (default vault uses fallback)"}` }), h("form", { class: "vmem-bar", onsubmit: e => {
        e.preventDefault();
        let piiPatterns;
        try { piiPatterns = JSON.parse(patterns.value); } catch { patterns.setCustomValidity("Use a JSON array of patterns"); patterns.reportValidity(); return; }
        patterns.setCustomValidity("");
        const changes = {};
        if (defaultVault.value !== (s.defaultVault ?? "")) changes.defaultVault = defaultVault.value;
        if (write.value !== s.write) changes.write = write.value;
        if (JSON.stringify(piiPatterns) !== JSON.stringify(s.piiPatterns ?? [])) changes.piiPatterns = piiPatterns;
        if (Number(resolution.value) !== s.graphResolution) changes.graphResolution = Number(resolution.value);
        if (enrichment.checked !== s.enrichmentEnabled) changes.enrichmentEnabled = enrichment.checked;
        host.action({ action: "settings", ...vaultParam(), changes });
      } }, defaultVault, write, patterns, resolution, h("label", {}, enrichment, h("span", { text: "Enable enrichment" })), h("button", { type: "submit", class: "btn", text: "Review settings" }))];
    },
    overview(s) {
      const vaults = s.status?.vaults ?? [];
      if (!vaults.length) return [ui.empty("No vault registered", "Run `vmem vaults add <id> <path>` to register one.")];
      return [
        searchForm(""),
        h("div", { class: "vmem-cards" },
          h("section", { class: "card" }, h("h2", { text: "Vaults" }),
            ui.rows(vaults, (v) => ui.row({ title: v.id, sub: `${v.kind} · write ${v.write}${v.health && v.health !== "ok" ? ` · ${v.health}` : ""}`, onOpen: () => go("overview", { vault: v.id }), ...(v.id === s.vault ? { chip: { text: "shown", tone: "neutral" } } : {}) }))),
          h("section", { class: "card" }, h("h2", { text: `${s.noteCount ?? 0}${s.noteCountCapped ? "+" : ""} notes · maps` }),
            ui.rows((s.mocs ?? []).slice(0, 8), (m) => ui.row({ title: m.title || m.path, sub: `${m.count} links`, onOpen: () => openNote(m.path) })) ?? ui.empty("No maps yet")),
          h("section", { class: "card" }, h("h2", { text: "Recent log" }),
            ui.rows(s.log ?? [], (r) => ui.row({ title: r.raw ?? `${r.type} ${r.source}${r.dest ? ` → ${r.dest}` : ""}`, ...(r.raw ? {} : { sub: `${r.at} · ${r.project}${r.agent ? " · agent" : ""}` }), onOpen: () => go("log") })) ?? ui.empty("Log is empty"))),
      ];
    },
    notes(s) {
      const list = s.notes ?? [];
      return [searchForm(s.q), s.error ? ui.notice(s.error, "err") : null,
        ui.rows(list, (n) => ui.row({ title: n.title || n.path, sub: [n.type, n.domain, n.description].filter(Boolean).join(" · "), onOpen: () => openNote(n.path) }))
          ?? ui.empty(s.q ? "No notes match" : "No notes", s.q ? "Try fewer words; terms are combined with AND." : undefined)];
    },
    note(s) {
      if (s.error) return [ui.notice(s.error, "err")];
      const n = s.note;
      if (!n) return [ui.empty("No note selected", "Open a note from Search or the palette.")];
      const fm = n.frontmatter ?? {};
      const moveInput = h("input", { type: "text", name: "to", class: "vmem-input", "aria-label": "New stem", placeholder: "new-stem" });
      const orgs = s.orgVaults ?? [];
      const orgSelect = orgs.length ? h("select", { name: "org", class: "vmem-input", "aria-label": "Org vault" }, ...orgs.map((o) => h("option", { value: o, text: o }))) : null;
      const out = s.links?.out ?? [], back = s.links?.in ?? [], dead = s.links?.dead ?? [];
      const links = [...out.map((l) => ({ path: l.resolved, label: `→ ${l.resolved}` })), ...back.map((l) => ({ path: l.source, label: `← ${l.source}` })), ...dead.map((l) => ({ label: `✕ ${l.target}` }))];
      const actions = [
        ui.button("Delete…", () => host.action({ action: "delete", path: n.path, ...vaultParam() }), { tone: "danger" }),
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
          { title: "Body", open: true, body: h("div", {}, h("pre", { class: "vmem-body", text: n.body ?? "" }), n.truncated ? ui.notice("Truncated; open the file for the rest.", "warn") : null) },
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
      // `reset` only says the page token was stale: the reply can land on the page holding the selected candidate.
      // The returned page index decides whether an earlier page exists; an unavailable reply has none, so there a
      // stale page param can still be cleared.
      const pageIndex = Number(String(s.page ?? "").split(":")[1]);
      const showFirst = Number.isSafeInteger(pageIndex) ? pageIndex > 0 : Boolean(params.page);
      return [s.unavailable ? ui.notice(s.unavailable, "err") : null, form,
        s.nextPage || showFirst ? h("div", { class: "vmem-bar" },
          ...(showFirst ? [ui.button("First page", () => go("promote"))] : []),
          ...(s.nextPage ? [ui.button("Next page", () => go("promote", { page: s.nextPage }))] : [])) : null,
        ui.rows(all, (c) => ui.row({ title: c.title || c.kind, sub: `${c.kind} · ${c.project} · ${new Date(c.at).toLocaleString()}`, onOpen: () => go("promote", { id: c.id, project: c.project, page: s.page }),
          ...(s.selected === c.id ? { chip: { text: "selected", tone: "neutral" } } : { verbs: [ui.button("Select", () => go("promote", { id: c.id, project: c.project, page: s.page }))] }) }))
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
      return [s.error ? ui.notice(s.error, "err") : null,
        ui.rows(r, (x) => {
          const p = x.dest ?? x.source;
          return ui.row({ title: x.raw ?? `${x.type}  ${x.source}${x.dest ? ` → ${x.dest}` : ""}`, sub: x.raw ? "unparsed line" : `${x.at} · ${x.project} · ${x.note}${x.agent ? " · agent" : ""}`,
            ...(typeof p === "string" && p.startsWith("notes/") ? { onOpen: () => openNote(p) } : {}) });
        }) ?? ui.empty("Log is empty")];
    },
    proposals(s) {
      const items = s.page?.items ?? [], p = s.selected;
      const stateSelect = h("select", { name: "state", class: "vmem-input", "aria-label": "Proposal state", onchange: () => go("proposals", { state: stateSelect.value }) },
        ...["pending", "applied", "rejected", "apply_unknown"].map((v) => h("option", { value: v, text: v, ...(v === s.state ? { selected: true } : {}) })));
      const reason = h("input", { type: "text", name: "reason", class: "vmem-input", "aria-label": "Rejection reason", placeholder: "reason for rejecting" });
      const detail = p ? ui.detail({
        kind: "proposal", title: p.path, state: { text: p.state, ...(p.state === "apply_unknown" ? { tone: "warn" } : {}) },
        actions: p.state === "pending" ? [
          ui.button("Apply…", () => host.action({ action: "proposal-apply", id: p.id, ...vaultParam() }), { tone: "primary" }),
          h("form", { class: "vmem-inline", onsubmit: (e) => { e.preventDefault(); if (reason.value.trim()) host.action({ action: "proposal-reject", id: p.id, reason: reason.value.trim(), ...vaultParam() }); } },
            reason, h("button", { type: "submit", class: "btn", text: "Reject…" })),
        ] : [],
        ...(p.decisionReason ? { summary: `reason: ${p.decisionReason}` } : {}),
        sections: [{ title: "Operation", open: true, body: h("div", {}, h("pre", { class: "vmem-body", text: p.content ?? "" }), p.truncated ? ui.notice("Truncated; read the rest with `vmem proposal show`.", "warn") : null) }],
        footer: [`${p.id} · ${p.createdAt}${p.agentLabelUnverified ? ` · agent ${p.agentLabelUnverified} (unverified)` : ""}`],
      }) : null;
      return [s.error ? ui.notice(s.error, "err") : null, h("div", { class: "vmem-bar" }, stateSelect,
        ...(s.page?.nextCursor ? [ui.button("Next page", () => go("proposals", { state: s.state, page: s.page.nextCursor }))] : [])), detail,
        ui.rows(items, (x) => ui.row({ title: x.path, sub: `${x.state} · ${x.createdAt}`, onOpen: () => go("proposals", { state: s.state, id: x.id }), ...(p?.id === x.id ? { chip: { text: "shown", tone: "neutral" } } : {}) }))
          ?? ui.empty(`No ${s.state} proposals`, "Agents submit proposals with `vmem_proposal_submit` when the vault opts in.")];
    },
    assertions(s) {
      const r = s.result, items = r?.items ?? [];
      const subject = h("input", { type: "text", name: "subject", class: "vmem-input", "aria-label": "Subject", placeholder: "subject (optional)", value: params.subject ?? "" });
      const relation = h("input", { type: "text", name: "relation", class: "vmem-input", "aria-label": "Relation", placeholder: "relation (optional)", value: params.relation ?? "" });
      const filter = h("form", { class: "vmem-bar", onsubmit: (e) => { e.preventDefault(); const { subject: _s, relation: _r, ...rest } = assertionQuery(); go("assertions", { ...rest, ...(subject.value.trim() ? { subject: subject.value.trim() } : {}), ...(relation.value.trim() ? { relation: relation.value.trim() } : {}) }); } },
        subject, relation, h("button", { type: "submit", class: "btn", text: "Filter" }));
      return [s.error ? ui.notice(s.error, "err") : null, filter,
        ...coverageNotices(s.warnings),
        ui.rows(items, (a) => ui.row({ title: `${a.subject} · ${a.relation}${a.value !== undefined ? ` = ${a.value}` : ""}`, sub: [a.op, a.from && `from ${a.from}`, a.to && `to ${a.to}`, a.on && `on ${a.on}`, `recorded ${a.recordedAt}`].filter(Boolean).join(" · "),
          ...(a.subjectNote?.path ? { onOpen: () => openNote(a.subjectNote.path) } : {}) }))
          ?? ui.empty("No assertions", "Agents record them with `vmem_assert`."),
        r?.continuation ? ui.button("Next page", () => go("assertions", { ...assertionQuery(), cursor: r.continuation })) : null];
    },
    history(s) {
      const path = h("input", { type: "text", name: "path", class: "vmem-input", "aria-label": "Note path", placeholder: "notes/stem.md", value: s.path ?? "" });
      const form = h("form", { class: "vmem-bar", onsubmit: (e) => { e.preventDefault(); if (path.value.trim()) go("history", { path: path.value.trim() }); } }, path, h("button", { type: "submit", class: "btn", text: "History" }));
      const revs = s.history?.revisions ?? [], changed = s.changes?.changed ?? [];
      const reason = s.history?.capability ?? s.changes?.capability;
      return [s.error ? ui.notice(s.error, "err") : null, form,
        reason ? ui.notice(`Git history is unavailable: ${reason}`, "warn") : null,
        s.changes ? h("section", { class: "card" }, h("h2", { text: `Changes ${s.changes.from.slice(0, 10)} → ${s.changes.to.slice(0, 10)}` }),
          ui.rows(changed, (c) => ui.row({ title: c.path, sub: c.status, onOpen: () => openNote(c.path) })) ?? ui.empty("No note changed"),
          s.changes.continuation ? ui.button("More changes", () => go("history", { ...(s.path ? { path: s.path } : {}), ...(params.cursor ? { cursor: params.cursor } : {}), from: s.changes.from, to: s.changes.to, changesCursor: s.changes.continuation })) : null) : null,
        s.path ? ui.rows(revs.map((r, i) => ({ r, prev: revs[i + 1] })), ({ r, prev }) => ui.row({ title: `${r.revision.slice(0, 10)} · ${r.committedAt}`, sub: `${r.bytes} bytes`,
          ...(prev ? { verbs: [ui.button("Changes since previous", () => go("history", { path: s.path, from: prev.revision, to: r.revision }))] } : {}) }))
          ?? ui.empty("No revisions", "The note has no committed history yet.") : ui.empty("No note selected", "Enter a note path to see its Git history."),
        s.history?.continuation ? h("div", { class: "vmem-bar" }, ui.button("Older revisions", () => go("history", { path: s.path, cursor: s.history.continuation })), ...(params.cursor ? [ui.button("Newest", () => go("history", { path: s.path }))] : [])) : null,
        s.history?.coverage && s.history.coverage.complete === false ? ui.notice(`History is incomplete${s.history.coverage.reason ? `: ${s.history.coverage.reason}` : ""}.`, "warn") : null];
    },
  };

  let last = "", savedView = "", savedSnapshot;
  const viewKey = () => JSON.stringify([panel, params]);
  const render = (snap) => {
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
  };
  host.onSnapshot((snap) => {
    if (snap.changed === false) {
      if (last === "" && savedView === viewKey() && savedSnapshot) render(savedSnapshot);
      return;
    }
    savedView = viewKey(); savedSnapshot = snap;
    render(snap);
  });
  return {
    show(id, p = {}) {
      panel = id; params = p; last = ""; root.replaceChildren();
      // Some shells suppress unchanged replies before invoking onSnapshot. Restore on show too.
      if (savedView === viewKey() && savedSnapshot) render(savedSnapshot);
    },
    hide() {},
    destroy() { root.remove(); },
  };
};
