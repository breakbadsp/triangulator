# QA run 20261028T172148Z-targeted-6541317

- Time: 2026-10-28 17:22 UTC
- Version: dev-6541317 (CI)

| Case | Revision | Status | Observation |
| --- | ---: | --- | --- |
| QA-001 | 1 | BLOCKED | Both checksums passed. First setup startup exited before browser connection; retry opened the target dashboard. Fresh thread updates were not verified. |

- Source: [CI run 40729119416](https://github.com/breakbadsp/triangulator/actions/runs/40729119416), revision `65413174dd952e200f4555e54802069eb70ac713`.
- Platform: Omarchy x86_64; EL9 sampler and collector packages. Both published checksums passed. Archive names and hashes are in the observation evidence.
- Browser: Electron 44.9.3, Chrome 152.0.7977.167; viewport 1280 × 800; isolated URL `http://127.0.0.1:34263/`.
- QA-001: The initial setup reported startup, but the collector and sampler exited before the browser connected. The browser reported `ERR_CONNECTION_REFUSED`. One restart in a retained session loaded the dashboard and showed the owned `sleep` target and one thread. Fresh updates were not checked.
- Focused observation: Clicking Resources changed the URL to `#resources` and put the section 125 pixels below the viewport top. This is a partial check, not a full case result.
- Focused checks blocked or incomplete: The Help info button was clicked but its content was not verified. The held memory-map snapshot across updates was not attempted. QA-002, QA-003, and QA-005 were not attempted after the setup interruption.
- Excluded: Full and Quick regression, other dashboard cases, and sampler and collector performance cases were outside this short targeted run. QA-060 remains a known failure outside this UI scope; its earlier result is unchanged.
