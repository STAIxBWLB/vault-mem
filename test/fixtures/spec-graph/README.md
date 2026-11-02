# Spec schema conformance fixtures

This small synthetic contract belongs to vault-mem #91. Consumers may copy the fixture without a runtime dependency on vault-mem. Each directory is a separate repository tree; do not combine cases into one tree.

Initialize a temporary Git repository for each directory, add and commit its files, then discover/validate it. `expected.json` lists the unique error and warning codes expected from each case. Repeated issues for different files may share a code. The parent-cycle case necessarily also violates the rank rule. The missing-type and unknown-type cases also demonstrate the orphan warning.

The `valid` case uses skipped rank levels, native relative pathspec lists, and plain/wiki id links with labels/headings. Missing verification stamps are allowed. Dynamic commit ancestry, dirty-tree freshness and `requireFresh` behavior are tested separately in temporary histories; fixture SHAs are deliberately invalid or unavailable.

| Case | Error classes | Warning classes |
|---|---|---|
| `valid` | - | - |
| `missing-id` | missing_id | - |
| `missing-type` | missing_type | orphan |
| `missing-title` | missing_title | - |
| `duplicate-id` | duplicate_id | - |
| `dangling-link` | dangling_link | - |
| `parent-cycle` | parent_cycle, type_rank | - |
| `type-rank` | type_rank | - |
| `unknown-type` | unknown_type | orphan |
| `unknown-status` | unknown_status | - |
| `superseded-self` | superseded_self | - |
| `superseded-status` | superseded_status | - |
| `superseded-dangling` | dangling_link | - |
| `link-list-shape` | wrong_shape | - |
| `single-link-shape` | wrong_shape | - |
| `covers-shape` | wrong_shape | - |
| `tags-shape` | wrong_shape | - |
| `paths-shape` | wrong_shape | - |
| `paths-empty` | wrong_shape | - |
| `paths-absolute` | invalid_paths | - |
| `paths-parent` | invalid_paths | - |
| `paths-unmatched` | invalid_paths | - |
| `invalid-verified-against` | invalid_verified_against | - |
| `unknown-verified-commit` | invalid_verified_against | - |
| `orphan` | - | orphan |
| `deprecated-without-replacement` | - | deprecated_without_replacement |
| `deprecated-replacement` | - | deprecated_replacement |
| `multiple-goals` | - | multiple_goals |
| `duplicate-covers` | - | duplicate_covers |
| `unknown-body-link` | - | unknown_body_link |
| `active-without-paths` | - | active_without_paths |
| `invalid-frontmatter` | invalid_frontmatter | - |

Required fields are nonempty strings: `id`, `type`, `title`. Types are `goal`, `architecture`, `module`, `submodule`; ranks are 0, 1, 2, 3 and child rank must exceed parent rank. Status is optional and, when present, is `draft`, `active` or `deprecated`. `parent` and `superseded-by` are single links; `depends-on`, `references` and `implements` are lists, including an empty list. `covers` and `tags` are lists of nonempty strings (empty lists are allowed); only valid `covers` lists contribute claims. `paths` is a nonempty list of relative Git pathspecs with no parent traversal and must match tracked files. Supersession is valid only on a deprecated spec and cannot point to itself or a missing node.

A validation candidate is named `SPEC.md` or has parsed frontmatter containing `id` or `type`. A plain/horizontal-rule README is not a candidate. With unparseable YAML, only the `SPEC.md` filename asserts candidacy. Only candidates with a usable id and type become graph nodes. Body links resolve by id and may use aliases/headings; unresolved body links warn. No fixture contains real note text, credentials or repository paths.
