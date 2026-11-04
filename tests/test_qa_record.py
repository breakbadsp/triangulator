import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class QaRecordTests(unittest.TestCase):
    def test_run_keeps_one_report_and_checks_extra_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts/qa').mkdir(parents=True)
            (root / 'docs/qa').mkdir(parents=True)
            for name in ('qa/qa_record.py', 'qa_summary.py'):
                shutil.copy(ROOT / 'scripts' / name, root / 'scripts' / name)
            (root / 'docs/qa/test-cases.md').write_text(
                '| QA-001 | NOT_RUN | - | - | - |\n\n## QA-001: Example\n- Revision: 1\n')
            (root / 'docs/qa/bug-lab-cases.md').write_text('')
            (root / 'README.md').write_text('<!-- qa-summary:start -->\n<!-- qa-summary:end -->\n')
            results = root / 'results.json'
            results.write_text(json.dumps({'QA-001': {'status': 'FAILED', 'observation': 'Expected A; saw B.'}}))
            details = root / 'details.md'
            details.write_text('## Environment\nTest package and browser.\n')
            run = root / 'docs/qa/runs/example'
            subprocess.run([sys.executable, str(root / 'scripts/qa/qa_record.py'),
                            '--run-dir', str(run), '--results', str(results), '--details', str(details),
                            '--label', 'test version'], check=True, capture_output=True, text=True)
            self.assertEqual([p.name for p in run.iterdir()], ['index.md'])
            report = (run / 'index.md').read_text()
            self.assertIn('Expected A; saw B.', report)
            self.assertIn('Test package and browser.', report)
            cases = (root / 'docs/qa/test-cases.md').read_text()
            self.assertEqual(cases.count('(runs/example/index.md)'), 2)
            (run / 'extra.log').write_text('extra')
            check = subprocess.run([sys.executable, str(root / 'scripts/qa_summary.py'), '--check'],
                                   capture_output=True, text=True, check=False)
            self.assertNotEqual(check.returncode, 0)
            self.assertIn('extra QA run file', check.stderr)


if __name__ == '__main__':
    unittest.main()
