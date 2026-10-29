# Synthetic analysis parity oracles

- Generated from the synthetic corpus in `../analysis-corpus.ts`; no private vault content is used.
- Lint oracle: unchanged `vault-lint/scripts/lint.py`, SHA256 `1b38d417aef8e3ea395da36e9c58dc2fa0d33bdb65fd2ea50a771a6f5dfa2ad6`.
- Graph oracle: unchanged `lib/build-graph.py`, SHA256 `5ff417ae8e129c208034516b7db8250473312ddeca669af0ba68931e4fd87aa8`.
- Lint checks compare the complete finding sets for L01/L02/L03/L09/L10/L11/L12. L13 is new and tested separately.
- Graph checks compare every extracted node field and the undirected edge set. Community partitioning deliberately uses the issue's deterministic bounded algorithm rather than Python's optional partitioner packages.
- The generated `vault-graph.json` uses the consumer-facing `nodes`/`edges` schema. Fixture graph tests cover serialization and community overlays.
- These results establish fixture parity only. Private corpus parity and reference retirement require separate evidence.
- Manual consumer readback: Maru `enrichGraph` at local commit `1971582255e36fbb09d30ecdec840f79c2ff2fdc` loaded this fixture and overlaid communities successfully. No Maru files were changed.
