# Mutation testing

Mutation runs are optional and do not change the source checkout. They can take
several minutes. Review surviving mutations: some are equivalent or affect
behavior outside the selected tests. A build error is not a killed mutant.

## Alerting

From the repository root, use a Python environment with fork support:

```sh
python3 -m venv /tmp/triangulator-mutation-venv
/tmp/triangulator-mutation-venv/bin/pip install -r tests/requirements-mutation.txt
rm -rf mutants/
/tmp/triangulator-mutation-venv/bin/mutmut run --max-children 2
/tmp/triangulator-mutation-venv/bin/mutmut results
```

The removal clears cached results, including results from earlier runs. This
ensures test changes are checked. This mutates `alerting/` and runs
`tests/test_alerting.py`. The tool keeps its
working copies and results in `mutants/`. See a change with
`/tmp/triangulator-mutation-venv/bin/mutmut show <mutant-name>`. Delete `mutants/` to start a fresh run.

## Dashboard

From `dashboard/`, run `npm ci` and then `npm run test:mutation`. The default
scope is memory assessment logic. To examine another assessment module, run:

```sh
npm run test:mutation -- --mutate 'src/lib/assess/watch.ts'
```

Stryker runs related Vitest tests in a temporary copy. It writes an HTML report
to `dashboard/reports/mutation/`. Its results do not replace type checking or
the full test suite.
