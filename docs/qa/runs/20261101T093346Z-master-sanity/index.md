# QA run 20261101T093346Z-master-sanity

- Time: 2026-11-01 09:34 UTC
- Version: source cdeef9f1, linux-x86_64

| Case | Revision | Status | Observation |
| --- | ---: | --- | --- |
| QA-001 | 1 | PASSED | Both source-built package checksums passed. Isolated install started without a compiler at installation. Browser identified sleep PID 5 with fresh thread and resource samples. |
| QA-002 | 1 | PASSED | Added owned PID 6 as second through Add target and confirmation. Both targets stayed live; second tile opened PID 6 and selection persisted after reload. |
| QA-003 | 1 | PASSED | Empty process input showed Please fill out this field. PID 2147483647 showed no running process before confirmation. Reload retained exactly two targets; no saved configuration change. |
| QA-005 | 1 | BLOCKED | Partial: live thread drawer, 1 min map, newest recording, previous time, disabled live charts, and hidden Settings editing observed. Preview then stopped responding; reads and snapshot timed out at 15000ms. Remaining replay, custom-range restoration, and Timeline preview expectations were not verified. No product verdict. |

- Source: origin/master cdeef9f11eebe3daa01e44db7b99cd0e75f930f5. The user explicitly requested a master source build.
- Build: make sqlite-amalgamation; make release -j2 SQLITE_SOURCE=build/sqlite/sqlite3.c. Package: scripts/package.sh source-cdeef9f1 linux-x86_64. Both components came from this commit.
- Package filenames and SHA-256: [package identity](evidence/package.json). These local packages have no published URL; source is https://github.com/breakbadsp/triangulator/tree/cdeef9f11eebe3daa01e44db7b99cd0e75f930f5.
- Environment: Omarchy Linux x86_64. One test sampler in a private PID namespace; existing host sampler preserved. Separate configuration, data, HTTP 35815 and UDP 59317. Browser: T3 Code preview, Chrome 152.0.7977.167 / Electron 44.9.3, 1280 x 800.
- Browser URL: http://127.0.0.1:35815/. Browser observations: [JSON](evidence/observations.json).
- QA-005 blocker: opened PID 6, chose All threads, opened TID 6, returned to Timeline, selected Previous from Live, then Previous again. Before the later replay action, an attempted custom From edit selected the year and changed 2026 to 2025; Load was not selected and a valid custom range was not established. Earlier observations showed historical session 3381290277766161652 and PID 6. After the later action, preview reads and snapshot timed out after 15000ms. Expected a responsive recorded view. HTTP root still returned 200. This does not establish whether the application or preview failed. No console or network failure was available. Failure screenshot capture also timed out.
- QA-005 remains BLOCKED. Custom range restoration, recorded-thread history presets, complete cross-panel session/value alignment, next/previous sequence, and Timeline preview without release remain unverified.
- Excluded: all cases outside Sanity. Existing failures in other cases were not retested and keep their historical results.
- The run exceeded the 40-tool-call target because preview references and selectors needed correction. No case definition changed. Test-owned processes stopped and the preview tab closed.
