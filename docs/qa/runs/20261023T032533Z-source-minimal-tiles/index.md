# Minimal overview: first attempts

- UTC: 2026-10-23 03:25:33 to 03:33:00.
- Source: local branch `fleet/minimal-tiles`, base `117f17ae80f2174baa0ba04495152f0c27c54ec3`. Source testing was explicitly authorized.
- Platform: Linux x86_64. Browser: T3 Chrome 154.0.0.0. URL: `http://127.0.0.1:19781/`; isolated UDP 19780 and data `/tmp/tri-minimal-qa/data`. No sampler started.
- Artifact A: `build/triangulator-collector`, SHA-256 `40ab244d9db7d8a4596d3a1354ada4afce69f45a9808b1e3d59d44cee7bc3b68`.
- Artifact B: responsive correction, SHA-256 `a3ff1cbf55f889ef5bdbaa70f5df273340c5120fb7d0cfb664182b169899fe25`.
- Package download/checksum: not applicable to the authorized source build. The source version was not changed.
- Definitions: existing unnumbered QA-087 and QA-088 definitions; QA-087 includes the requested 320 px check.

| Case | Artifact | Status | Observation |
| --- | --- | --- | --- |
| QA-087 | A | FAILED | At 320 px, the grid area was 296 px, but its column was 310 px. The page scrolled to 322 px. |
| QA-088 | B | FAILED | The `fleet` guide omitted the trend-rule limit required by the case. The `fleet-tile` guide contained it. |

Reproduction: open the populated overview and resize to 320 px. Expected: no horizontal overflow. Actual: each tile ended at x=322. Open Explain Targets overview. Expected: the guide states that tiles do not run trend rules. Actual in artifact B: only the network-traffic limit appeared.

Evidence: [first overflow](evidence/320px-first-failure.png), [measurements and guide text](evidence/observations.json). Both failures were corrected in later artifacts. See the [final retest](../20261023T033403Z-source-minimal-tiles/index.md). Keep these failed observations for their artifact identities.
