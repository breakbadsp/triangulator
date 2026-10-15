# Manual checks for concurrent dashboard viewers

These checks need independent browser views. Automated coverage is in
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
