# Regenerates python-oracle.json from the unchanged skill-mine Python (STAIxBWLB/skills ab4aa98).
# Run from skills/skill-mine/scripts/skill_miner with an interpreter that has PyYAML and networkx:
#   python /path/to/python-oracle.py > /path/to/python-oracle.json
# Every input below is synthetic.
import json, sys, math
sys.path.insert(0, ".")
import materialize as m
import networkx as nx
# analyze imports graph_build which loads bundle lib; load functions directly
import importlib.util, types
src = open("analyze.py").read().replace("import graph_build\n", "graph_build = type('g',(),{'BUNDLE_ROOT': __import__('pathlib').Path('.')})\n")
an = types.ModuleType("an"); exec(compile(src, "analyze.py", "exec"), an.__dict__)
actions = [{"canon":"summarize","surface":["요약","요약해줘","summarize","summary"]},{"canon":"organize","surface":["정리","정리해줘","organize","tidy"]},{"canon":"create","surface":["작성","create","write","draft"]}]
objects = [{"canon":"meeting-notes","surface":["회의록","meeting","meeting-notes"]},{"canon":"email","surface":["메일","email","Gmail"]},{"canon":"inbox","surface":["inbox","수신함"]}]
projects = [{"id":"alpha","name":"Alpha","keywords":{"ko":["알파"],"en":["Alpha Lab"]},"acronyms":["AL"],"people":["Kim Minsu","홍길동"],"orgs":["Acme Corp"],"sub_projects":[{"id":"alpha-web","keywords_extra":["web portal"]}]}]
idx = m.build_surface_index(actions, objects, projects)
texts = ["Please summarize the Meeting notes for Alpha Lab", "회의록 요약해줘 그리고 메일 작성", "TIDY the inbox; write a DRAFT", "홍길동 asked Kim Minsu about AL web portal", "summarizes GMAIL"]
out = {"index": [list(t) for t in idx], "matches": [sorted([list(h) for h in m.find_matches(t, idx)]) for t in texts]}
out["slug"] = [m.slugify(s) for s in ["Acme Corp", "  Hello  World ", "a/b:c", "", "회의 록!!", "x__y..z"]]
people = m._all_people(projects)
out["people"] = people
out["mask"] = [m.mask_text(t, people) for t in ["mail me at kim@example.org", "see /Users/x/notes/a.md and ~/w/b", "C:\\Users\\x\\f.txt done", "홍길동 met Kim Minsu"]]
out["fm"] = an._parse_frontmatter("---\nname: vault-sync\ndescription: Scan work for changes\n  and propose extractions\nx: 1\n---\nbody\n")
out["tok"] = sorted(an._tokenize("Vault-sync: scan 회의록 a b_c ZZ"))
out["jac"] = [an.jaccard({"a","b"},{"b","c"}), an.jaccard(set(),{"a"})]
# community_to_candidate on a hand graph
G = nx.Graph()
recs = {"p_1":"2026-10-01T09:00:00Z","p_2":"2026-10-03T09:00:00Z","p_3":"2026-10-03T18:00:00Z","p_4":"2026-10-08T09:00:00Z"}
for k,v in recs.items(): G.add_node(k, type="prompt", timestamp=v)
for n in ["action--summarize","object--meeting-notes","object--email","entity--org--acme-corp"]: G.add_node(n, type=n.split("--")[0])
E=[("p_1","action--summarize"),("p_1","object--meeting-notes"),("p_2","action--summarize"),("p_2","object--meeting-notes"),("p_3","action--summarize"),("p_3","object--email"),("p_4","object--meeting-notes"),("p_4","entity--org--acme-corp")]
G.add_edges_from(E)
existing=[{"name":"meeting-notes","bag":an._tokenize("meeting-notes Turn a transcript into meeting notes")},{"name":"summarize","bag":an._tokenize("summarize summarize text")}]
c = an.community_to_candidate(0, list(G.nodes), G, existing)
out["cand"] = {k: c[k] for k in ["label","gloss","size","day_span","unique_days","cohesion","novelty","rank","triggers","trigger_nodes","similar_skills"]}
print(json.dumps(out, ensure_ascii=False))
