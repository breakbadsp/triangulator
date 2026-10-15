# Manual browser checks

These checks need browser or human observation. Automated coverage is in
`tests/test_dashboard_concurrency.py` and `tests/dashboard_test.js`.

## QA-045: Concurrent viewers and slow connections

Feature: Dashboard HTTP concurrency. Priority: High. Case revision: 1. Status: NOT_RUN.

Preconditions: An isolated matching package monitors an owned process. Use
20 independent Chrome profiles or devices. Use only the test runtime's ports.
Prepare a TCP client that can hold an incomplete HTTP request open.

1. Open the dashboard in all 20 views. Compare the current PID and freshness.
2. Keep one raw connection idle. Keep another connection sending an incomplete
   header one byte per second. Observe all dashboard views for 10 seconds.
3. Inspect a recording or thread history in one view. Keep the others live.
4. Close the raw connections. Check that all live views continue to refresh.
5. Stop and restart the test collector. Observe both the outage and recovery.

Expected results: Slow connections do not stop other views from refreshing.
An incomplete request closes after its total five-second read deadline even
when bytes keep arriving. History and replay stay local to their view. All
views identify an outage and recover without presenting stale data as fresh.
Automated HTTP tests alone do not satisfy these browser expectations.

## QA-046: Conflicting watch-rule saves and resets

Feature: Shared watched-thread settings. Priority: High. Case revision: 1. Status: NOT_RUN.

Preconditions: An isolated package supports conditional watch-rule updates.
Two Chrome views load the same saved rules in Settings.

1. Edit a rule in A and a different rule in B. Save A, then save B.
2. Check B's fields, conflict message, Save, Reset to config file, and
   Reload current rules. Inspect A's saved rules from a fresh view.
3. Select Reload current rules in B and cancel. Repeat with a failed network
   read. Then restore the connection and confirm the reload.
4. Edit and save from B. Check that the reviewed current rules remain unless
   the operator deliberately changed them.
5. Load the saved rules in A and B again. Save a change in A, then attempt
   Reset to config file in B. Check the conflict and the saved rules.
6. Restart the collector while an edited draft is open. Attempt to save it.
7. Open help for Save, Reset to config file, and Reload current rules.

Expected results: A stale save or reset returns HTTP 409 and changes no saved
rule. The draft stays visible. Save and Reset remain off until current rules
are loaded. Cancel and a failed reload preserve the draft. A successful reload
replaces it only after confirmation and enables editing of the current list.
A collector restart also refuses an earlier draft. Help explains that settings
are shared, why the change was refused, and how to retain edits before reloading.
Leave this case NOT_RUN until these steps are executed in the browser.

## QA-038: Timeline and past assessments show a recorded finding

Feature: Timeline. Priority: High. Case revision: 3.

Preconditions: Use an isolated runtime, unused ports, and enabled recording.
Use a bug-lab workload that can switch between healthy activity and a CPU spin.
Record both states before opening the dashboard.

1. Read the Timeline marks and Past assessments rows. Compare their times with
   the controlled CPU spin.
2. Select the spin finding. Scroll through the dashboard and read the top bar,
   Assessment, and thread table. Compare them with the selected recording.
3. Select **Back to live**. Drag the handle onto the finding mark and release
   it. Use **◀** and **▶**. Release the handle at the right end.
4. From Live, use one ArrowLeft step on the handle and release it. Then move
   it to the right end again. Repeat after new live samples arrive.
5. Change each severity checkbox and the type filter. Compare the visible
   rows with the timeline marks.

Expected results: The row and mark identify the controlled finding. Selecting
it moves every panel to its worst recorded moment without scrolling the page.
The row shows its detail and selection, and the top bar identifies the recorded
time. The buttons and handle open recordings consistently. The previous step
opens a recording; the right end returns to Live. Filters change rows and marks
together. Live trends return when the recorded view closes.

## QA-039: Earlier Timeline periods, empty states, and help

Feature: Timeline. Priority: Medium. Case revision: 3.

Preconditions: As QA-038, with at least two hours of recordings. Use a second
isolated collector with recording disabled.

1. Scroll the findings list to its end, select **Load earlier**, and release
   the handle at the left end. Observe the list position and timeline bounds.
2. Stop only the test collector. Select **Load earlier**, then restart it and
   retry. Open the collector with recording disabled.
3. Hover for 1.2 seconds on the Timeline title, handle, marks, **◀**, **▶**,
   **Live**, top-bar return button, Past assessments title, severity controls,
   type filter, row, status line, and **Load earlier**.
4. Open the Timeline and Past assessments guides with pointer and keyboard.
   Check Escape and touch access. Check the controls below 640 pixels wide.

Expected results: Earlier checks extend the timeline without resetting the
list position. The error identifies the failed read and permits a retry. The
collector with recording disabled shows a clear empty state. Help appears for
every control and explains recording gaps, coarse checks, and missing live
trends. The guides remain readable with keyboard and touch. Controls wrap on a
narrow screen, and the list scrolls inside the card.
