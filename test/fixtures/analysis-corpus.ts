import type { AnalysisSnapshot } from "../../src/analysis-types.ts";
export function analysisCorpus(logPath = "/fixture/log"): AnalysisSnapshot {
  const note = (type: string, extra = "", body = "") => `---\ntype: ${type}\ndescription: Synthetic fixture.\n${extra}---\n${body}\n`;
  return {
    today:"2026-08-19",logPath,registryIds:["rise"],
    notes:[
      {path:"a.md",source:note("insight",'topics: ["[[projects]]"]\n',"[[b]] [[missing-note]]\n```\n[[fenced-missing]]\n```\n")},
      {path:"b.md",source:note("decision",'topics: ["[[projects]]"]\nconfidence: on\nstatus: done\nproject: "[[absent]]"\n',"[[a]]")},
      {path:"c.md",source:note("insight","project: nope\nconfidence: 010\nstatus: 1e3\n")},
      {path:"d.md",source:note("method",'topics: ["[[projects]]"]\n',"[[e]]")},
      {path:"e.md",source:note("reference",'topics: ["[[projects]]"]\n',"[[d]]")},
      {path:"index.md",source:"---\ntype: moc\ndescription: off\n---\n"},
      {path:"invalid.md",source:"---\ntype: [unclosed\n---\n[[a]]\n"},
      {path:"no-fm.md",source:"A synthetic missing-frontmatter fixture. [[ghost]]\n"},
      {path:"projects.md",source:note("moc",'topics: ["[[index]]"]\n')},
    ],
    log:"# fixture\n2026-08-01 10:00  EXTRACT  rise  synthetic\n2026-07-19 09:00  RENAME  -  legacy\nbad structure\n2026-08-02 10:00  BOGUS  -  synthetic\n",
    reports:{"graph-report-260101.md":"# Synthetic old report\n","vault-graph.json":JSON.stringify({nodes:[{id:"a",community:0},{id:"b",community:0},{id:"c",community:1},{id:"d",community:2},{id:"e",community:2}],edges:[{source:"a",target:"b"},{source:"b",target:"c"},{source:"d",target:"e"}]})},
  };
}
