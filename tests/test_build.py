"""Check build option tracking without compiling."""
import os
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


class BuildOptionsTests(unittest.TestCase):
    def run_make(self, directory, *arguments, path=None):
        environment = os.environ.copy()
        environment.pop("MAKEFLAGS", None)
        environment.pop("MFLAGS", None)
        environment.pop("STATIC", None)
        if path is not None:
            environment["PATH"] = str(path)
        return subprocess.run(
            [shutil.which("make"), "--no-print-directory", "build/build_options", *arguments],
            cwd=directory, env=environment, capture_output=True, text=True, timeout=10)

    def prepare(self, directory):
        shutil.copyfile(ROOT / "Makefile", Path(directory) / "Makefile")
        tools = Path(directory) / "tools"
        tools.mkdir()
        for name in ("mkdir", "mv", "rm", "true"):
            (tools / name).symlink_to(shutil.which(name))
        return tools

    def test_required_thread_library_preserves_custom_libraries(self):
        for libraries in ("", "-lm"):
            with self.subTest(libraries=libraries), tempfile.TemporaryDirectory() as directory:
                self.prepare(directory)
                result = self.run_make(directory, f"LDLIBS={libraries}")
                self.assertEqual(result.returncode, 0, result.stderr)
                options = (Path(directory) / "build/build_options").read_text().split()
                self.assertIn("-pthread", options)
                if libraries:
                    self.assertIn(libraries, options)

    def test_sanitizer_modes_replace_static_linkage_and_preserve_warnings(self):
        for mode, flags in (("address", "address,undefined"), ("thread", "thread")):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                self.prepare(directory)
                result = self.run_make(directory, f"SANITIZER={mode}", "LDLIBS=-lm",
                                       "SAMPLER_LDFLAGS=-static", "RUNTIME_LDFLAGS=-static")
                self.assertEqual(result.returncode, 0, result.stderr)
                options = (Path(directory) / "build/build_options").read_text().split()
                self.assertIn(f"-fsanitize={flags}", options)
                self.assertIn("-fno-sanitize-recover=all", options)
                self.assertIn("-Werror", options)
                self.assertIn("-pthread", options)
                self.assertIn("-lm", options)
                self.assertNotIn("-static", options)
                self.assertNotIn("-static-libstdc++", options)
                self.assertNotIn("-static-libgcc", options)
                if mode == "thread":
                    self.assertIn("-O0", options)
                    self.assertIn("-fPIE", options)
                    self.assertIn("-pie", options)

    def test_invalid_sanitizer_and_static_sanitizer_fail_early(self):
        for arguments in (("SANITIZER=address,thread",), ("SANITIZER=address thread",),
                          ("SANITIZER=memory",), ("SANITIZER=thread", "STATIC=1")):
            with self.subTest(arguments=arguments), tempfile.TemporaryDirectory() as directory:
                self.prepare(directory)
                result = self.run_make(directory, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("SANITIZER", result.stderr)

    def test_sanitizer_options_do_not_inherit_the_outer_static_build(self):
        with tempfile.TemporaryDirectory() as directory:
            self.prepare(directory)
            with patch.dict(os.environ, {"STATIC": "1", "MAKEFLAGS": "STATIC=1"}):
                result = self.run_make(directory, "SANITIZER=address")
            self.assertEqual(result.returncode, 0, result.stderr)
            options = (Path(directory) / "build/build_options").read_text().split()
            self.assertIn("-fsanitize=address,undefined", options)
            self.assertNotIn("-static", options)

    def test_sanitizer_mode_changes_update_build_options(self):
        with tempfile.TemporaryDirectory() as directory:
            self.prepare(directory)
            saved = []
            for mode in ("", "address", "thread", ""):
                result = self.run_make(directory, f"SANITIZER={mode}")
                self.assertEqual(result.returncode, 0, result.stderr)
                saved.append((Path(directory) / "build/build_options").read_text())
            self.assertEqual(saved[0], saved[3])
            self.assertEqual(len(set(saved)), 3)

    def test_build_options_do_not_require_cmp(self):
        with tempfile.TemporaryDirectory() as directory:
            tools = self.prepare(directory)
            result = self.run_make(directory, path=tools)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((Path(directory) / "build/build_options").exists())

    def test_same_options_preserve_the_timestamp_and_new_options_replace_them(self):
        with tempfile.TemporaryDirectory() as directory:
            self.prepare(directory)
            first = self.run_make(directory, "CXXFLAGS=-O2")
            self.assertEqual(first.returncode, 0, first.stderr)
            options = Path(directory) / "build/build_options"
            before = options.stat().st_mtime_ns
            old_options = options.read_text()
            unchanged = self.run_make(directory, "CXXFLAGS=-O2")
            self.assertEqual(unchanged.returncode, 0, unchanged.stderr)
            self.assertEqual(options.stat().st_mtime_ns, before)
            changed = self.run_make(directory, "CXXFLAGS=-O3")
            self.assertEqual(changed.returncode, 0, changed.stderr)
            self.assertIn("-O3", options.read_text())
            self.assertNotEqual(options.read_text(), old_options)

    def test_build_options_ignore_a_failing_cmp(self):
        with tempfile.TemporaryDirectory() as directory:
            tools = self.prepare(directory)
            first = self.run_make(directory, "CXXFLAGS=-O2")
            self.assertEqual(first.returncode, 0, first.stderr)
            failing_cmp = tools / "cmp"
            failing_cmp.write_text("#!/bin/sh\nexit 2\n")
            failing_cmp.chmod(0o755)
            changed = self.run_make(directory, "CXXFLAGS=-O3", path=tools)
            self.assertEqual(changed.returncode, 0, changed.stderr)
            self.assertIn("-O3", (Path(directory) / "build/build_options").read_text())


class ObjectReuseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        shutil.copyfile(ROOT / "Makefile", self.directory / "Makefile")
        for name in ("sampler", "common", "sqlite"):
            (self.directory / name).mkdir()
        for name in ("sampler/main.cpp", "common/header.hpp", "sqlite/sqlite3.c", "sqlite/sqlite3.h"):
            (self.directory / name).write_text("// Build dependency fixture.\n")
        self.compiler = self.directory / "compiler"
        self.compiler.write_text(
            "#!/usr/bin/env python3\n"
            "import json, pathlib, sys\n"
            "with open('calls.jsonl', 'a') as log: log.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "if '-o' in sys.argv: pathlib.Path(sys.argv[sys.argv.index('-o') + 1]).touch()\n")
        self.compiler.chmod(0o755)

    def build(self, target="build/triangulator-sampler", *options):
        environment = os.environ.copy()
        for name in ("MAKEFLAGS", "MFLAGS", "STATIC", "SANITIZER", "COMPILER_CACHE"):
            environment.pop(name, None)
        result = subprocess.run(
            ["make", "--no-print-directory", target, f"CXX={self.compiler}", *options],
            cwd=self.directory, env=environment, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.directory / "calls.jsonl"
        result = [json.loads(line) for line in calls.read_text().splitlines()]
        calls.write_text("")
        return result

    def test_link_library_change_relinks_without_recompiling(self):
        self.build("build/triangulator-sampler", "LDLIBS=-lm")
        calls = self.build("build/triangulator-sampler", "LDLIBS=-lrt")
        self.assertEqual(len(calls), 1)
        self.assertIn("-lrt", calls[0])
        self.assertIn("build/triangulator-sampler.o", calls[0])
        self.assertNotIn("-c", calls[0])

    def test_header_and_compiler_flag_changes_recompile(self):
        self.build()
        (self.directory / "common/header.hpp").write_text("// Changed header.\n")
        self.assertTrue(any("-c" in call for call in self.build()))
        self.assertTrue(any("-c" in call for call in self.build("build/triangulator-sampler", "CXXFLAGS=-O3")))

    def test_sqlite_reuse_ignores_cpp_flags_but_checks_c_flags(self):
        arguments = ("SQLITE_SOURCE=sqlite/sqlite3.c",)
        self.build("build/sqlite3.o", *arguments)
        calls = self.build("build/sqlite3.o", *arguments, "CXXFLAGS=-O3")
        self.assertFalse(any("-c" in call for call in calls))
        calls = self.build("build/sqlite3.o", *arguments, "SQLITE_CFLAGS=-O3")
        self.assertTrue(any("-c" in call and "-O3" in call for call in calls))

    def test_cache_wraps_compilation_only(self):
        wrapper = self.directory / "cache"
        wrapper.write_text('#!/bin/sh\nprintf "cache\\n" >> cache-calls\nexec "$@"\n')
        wrapper.chmod(0o755)
        self.build("build/triangulator-sampler", f"COMPILER_CACHE={wrapper}")
        self.assertEqual((self.directory / "cache-calls").read_text(), "cache\n")
