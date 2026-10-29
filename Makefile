# Choose the compiler from outside; never edit this file for it:
#   make CXX=g++-14        or        CXX=clang++-19 make
# GNU Make predefines CXX as g++, so "?=" never applies; test the origin.
ifeq ($(origin CXX),default)
CXX := c++
endif
# Optional compiler cache. Linking always uses the selected compiler directly.
COMPILER_CACHE ?=
CXXFLAGS ?= -O2 -flto=auto -Wall -Wextra -Werror -Wconversion -Wshadow
CPPFLAGS ?=
LDFLAGS ?=
# glibc before 2.34 keeps pthread symbols in a separate library.
LDLIBS ?=
override LDLIBS += -pthread
READELF ?= readelf
# The production-host sampler always needs only the kernel. Other programs
# embed the C++ runtime; STATIC=1 also embeds libc and SQLite.
STATIC ?= 0
SAMPLER_LDFLAGS ?= -static
RUNTIME_LDFLAGS ?= -static-libstdc++ -static-libgcc
ifeq ($(STATIC),1)
RUNTIME_LDFLAGS := -static
endif
# Sanitizers require dynamic libc and C++ runtimes. AddressSanitizer and
# ThreadSanitizer must run in separate builds.
SANITIZER ?=
ifneq ($(SANITIZER),)
ifeq ($(filter $(SANITIZER),address thread),)
$(error SANITIZER must be address or thread)
endif
ifneq ($(words $(SANITIZER)),1)
$(error SANITIZER must be address or thread)
endif
ifeq ($(STATIC),1)
$(error STATIC=1 is incompatible with SANITIZER)
endif
override SAMPLER_LDFLAGS :=
override RUNTIME_LDFLAGS :=
ifeq ($(SANITIZER),address)
SANITIZERS := address,undefined
else
SANITIZERS := thread
endif
# GCC 14 reports false maybe-uninitialized warnings in std::variant moves
# with -O1 and ThreadSanitizer. Keep warnings enabled and use -O0 for this mode.
SANITIZER_FLAGS := $(if $(filter thread,$(SANITIZER)),-O0,-O1) -g -fno-omit-frame-pointer -fsanitize=$(SANITIZERS) -fno-sanitize-recover=all
override CXXFLAGS += $(SANITIZER_FLAGS)
override LDFLAGS += -fsanitize=$(SANITIZERS)
override CPPFLAGS += -DTRIANGULATOR_SANITIZER
ifeq ($(SANITIZER),thread)
override CXXFLAGS += -fPIE
override LDFLAGS += -pie
endif
export SANITIZER
endif
# Optional local SQLite amalgamation: no download or vendored source required.
# It is compiled as C with $(CXX) -x c, so no separate C compiler setting exists.
SQLITE_SOURCE ?=
SQLITE_CFLAGS ?= -O2
ifneq ($(SANITIZER),)
override SQLITE_CFLAGS += $(SANITIZER_FLAGS)
ifeq ($(SANITIZER),thread)
override SQLITE_CFLAGS += -fPIE
endif
endif
CLANG_FORMAT ?= clang-format
SAMPLER_HEADERS := $(wildcard sampler/*.hpp)
COMMON_HEADERS := $(wildcard common/*.hpp)
COLLECTOR_HEADERS := $(wildcard collector/*.hpp)
COLLECTOR_LIBS ?= -lsqlite3
ifneq ($(strip $(SQLITE_SOURCE)),)
override CPPFLAGS += -I$(dir $(SQLITE_SOURCE))
SQLITE_OBJECT := build/sqlite3.o
SQLITE_HEADER := $(dir $(SQLITE_SOURCE))sqlite3.h
COLLECTOR_LIBS := $(SQLITE_OBJECT) -lm -pthread
endif
CPP_SOURCES := examples/buggy-workload/buggy_workload.cpp tests/benchmark_target.cpp tests/benchmark_victim.cpp tests/benchmark_sampling.cpp tests/runtime_threads.hpp $(COMMON_HEADERS) sampler/main.cpp $(SAMPLER_HEADERS) tests/sampler_test.cpp tests/allocation_test.cpp \
	collector/main.cpp $(COLLECTOR_HEADERS) tests/collector_test.cpp tests/collector_allocation_test.cpp \
	tests/wire_test.cpp

.PHONY: all check check-asan check-tsan check-sanitizers clean format format-check release scout sqlite-amalgamation dashboard-check FORCE
all: build/triangulator-sampler build/triangulator-collector

# Rebuild when link mode, compiler or flags change, including after release.
build:
	mkdir -p $@

# Make reads the saved options when it starts and writes them only on a change,
# so the file's timestamp changes only then. Make 4.2 or later reads files.
BUILD_OPTIONS := $(CXX) $(CPPFLAGS) $(CXXFLAGS) $(LDFLAGS) $(LDLIBS) $(SAMPLER_LDFLAGS) $(RUNTIME_LDFLAGS) $(COLLECTOR_LIBS) $(SQLITE_SOURCE) $(SQLITE_CFLAGS)
ifneq ($(file <build/build_options),$(BUILD_OPTIONS))
build/build_options: FORCE | build
	@$(file >$@,$(BUILD_OPTIONS)) true
endif

# Link-only changes do not invalidate compiled objects.
COMPILE_OPTIONS := $(CXX) $(CPPFLAGS) $(CXXFLAGS) $(LDFLAGS) $(SAMPLER_LDFLAGS) $(RUNTIME_LDFLAGS)
ifneq ($(file <build/compile_options),$(COMPILE_OPTIONS))
build/compile_options: FORCE | build
	@$(file >$@,$(COMPILE_OPTIONS)) true
endif

# SQLite has its own compiler flags. C++ and link changes do not rebuild it.
SQLITE_OPTIONS := $(CXX) $(CPPFLAGS) $(SQLITE_CFLAGS) $(SQLITE_SOURCE)
ifneq ($(file <build/sqlite_options),$(SQLITE_OPTIONS))
build/sqlite_options: FORCE | build
	@$(file >$@,$(SQLITE_OPTIONS)) true
endif

build/sqlite3.o: $(SQLITE_SOURCE) $(SQLITE_HEADER) build/sqlite_options Makefile | build/compiler_ok
	$(COMPILER_CACHE) $(CXX) -x c $(CPPFLAGS) $(SQLITE_CFLAGS) -DSQLITE_OMIT_LOAD_EXTENSION -c $< -o $@

# Optional download of the SQLite amalgamation for fully static builds. Nothing
# else except npm ci in this Makefile uses the network. The script checks the published hash.
sqlite-amalgamation:
	python3 -I scripts/fetch-sqlite.py build/sqlite

# Stop early, with a clear message, if the compiler lacks C++23 library support.
# The stamp is renewed when the compiler or compilation flags change.
build/compiler_ok: build/compile_options
	@printf '%s\n' '#include <bit>' '#include <expected>' '#include <format>' \
		'int main() { return std::expected<int, int>(std::byteswap(1)).value() == 0; }' | \
		$(CXX) $(CPPFLAGS) -std=c++23 -x c++ -fsyntax-only - || { \
		echo "error: '$(CXX)' cannot compile C++23 (needs <expected>, <format>, std::byteswap)." >&2; \
		echo "Install GCC 13+ or Clang 17+, then run: make CXX=<compiler>   (for example CXX=g++-14)." >&2; \
		exit 1; }
	@touch $@

release:
ifeq ($(strip $(SQLITE_SOURCE)),)
	@printf 'int main() {}\n' | $(CXX) -x c++ - -static -lsqlite3 -o /dev/null 2>/dev/null || { \
		echo "error: no static SQLite library (libsqlite3.a) found." >&2; \
		echo "Run: make sqlite-amalgamation && make release SQLITE_SOURCE=build/sqlite/sqlite3.c" >&2; \
		exit 1; }
endif
	$(MAKE) all STATIC=1
	@for binary in build/triangulator-sampler build/triangulator-collector; do \
		$(READELF) -lW "$$binary" > build/release_segments.tmp || exit 1; \
		$(READELF) -dW "$$binary" > build/release_dynamic.tmp || exit 1; \
		if grep -Eq 'INTERP|NEEDED' build/release_segments.tmp build/release_dynamic.tmp; then \
			echo "release binary has dynamic dependencies: $$binary" >&2; exit 1; \
		fi; \
	done
	@rm -f build/release_segments.tmp build/release_dynamic.tmp

build/triangulator-sampler.o: sampler/main.cpp $(SAMPLER_HEADERS) $(COMMON_HEADERS) build/compiler_ok Makefile
	mkdir -p build
	$(COMPILER_CACHE) $(CXX) $(CPPFLAGS) $(CXXFLAGS) $(SAMPLER_LDFLAGS) -std=c++23 -pthread $(LDFLAGS) -c $< -o $@

build/triangulator-sampler: build/triangulator-sampler.o build/compiler_ok Makefile build/build_options
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(SAMPLER_LDFLAGS) $(LDLIBS) -o $@

# The collector embeds dashboard/dist/index.html, so the binary serves the
# page without reading files at run time. od writes the page's bytes as a
# comma-separated list that collector/http.hpp includes. (C++26 #embed does
# the same but needs GCC 15 or Clang 19; this works with any C++23 compiler.)
dashboard/node_modules/.package-lock.json: dashboard/package.json dashboard/package-lock.json
	cd dashboard && npm ci

# Tests and their helpers do not change the page, so they do not rebuild it.
DASHBOARD_SOURCES := $(shell find dashboard/src -type f ! -name '*.test.*' ! -name 'test-*')
dashboard/dist/index.html: $(DASHBOARD_SOURCES) dashboard/index.html dashboard/vite.config.ts dashboard/tsconfig.json dashboard/node_modules/.package-lock.json
	cd dashboard && npm run build

build/dashboard_html.inc: dashboard/dist/index.html Makefile
	mkdir -p build
	od -An -v -tu1 $< > $@.od
	sed 's/^ *//; s/ *$$//; s/  */,/g; s/$$/,/' $@.od > $@.tmp
	mv $@.tmp $@
	rm -f $@.od

build/triangulator-collector.o: collector/main.cpp $(COLLECTOR_HEADERS) $(COMMON_HEADERS) sampler/parsing.hpp build/dashboard_html.inc build/compiler_ok Makefile
	mkdir -p build
	$(COMPILER_CACHE) $(CXX) $(CPPFLAGS) $(CXXFLAGS) -Ibuild $(RUNTIME_LDFLAGS) -std=c++23 -pthread $(LDFLAGS) -c $< -o $@

build/triangulator-collector: build/triangulator-collector.o $(SQLITE_OBJECT) build/compiler_ok Makefile build/build_options
	mkdir -p build
	$(CXX) $(CPPFLAGS) -Ibuild $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(RUNTIME_LDFLAGS) $(LDLIBS) $(COLLECTOR_LIBS) -o $@

build/sampler-test.o: tests/sampler_test.cpp $(SAMPLER_HEADERS) $(COMMON_HEADERS) build/compiler_ok Makefile
	mkdir -p build
	$(COMPILER_CACHE) $(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 -pthread $(LDFLAGS) -c $< -o $@

build/sampler-test: build/sampler-test.o build/compiler_ok Makefile build/build_options
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

# Normal builds use static linkage to count libc and libstdc++ allocations.
# Sanitizer builds use the runtime allocation hook.
build/allocation-test.o: tests/allocation_test.cpp sampler/main.cpp $(SAMPLER_HEADERS) $(COMMON_HEADERS) build/compiler_ok Makefile
	mkdir -p build
	$(COMPILER_CACHE) $(CXX) $(CPPFLAGS) $(CXXFLAGS) $(SAMPLER_LDFLAGS) -std=c++23 -pthread $(LDFLAGS) -c $< -o $@

build/allocation-test: build/allocation-test.o build/compiler_ok Makefile build/build_options
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(SAMPLER_LDFLAGS) \
		$(if $(SANITIZER),,-Wl,--wrap=malloc,--wrap=calloc,--wrap=realloc) $(LDLIBS) -o $@

build/wire-test.o: tests/wire_test.cpp $(COMMON_HEADERS) build/compiler_ok Makefile
	mkdir -p build
	$(COMPILER_CACHE) $(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 -pthread $(LDFLAGS) -c $< -o $@

build/wire-test: build/wire-test.o build/compiler_ok Makefile build/build_options
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

# Normal builds replace malloc for every library through dynamic libc.
# Sanitizer builds retain the runtime allocator and use its allocation hook.
build/collector-allocation-test.o: tests/collector_allocation_test.cpp $(COLLECTOR_HEADERS) $(COMMON_HEADERS) build/compiler_ok Makefile
	mkdir -p build
	$(COMPILER_CACHE) $(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 -pthread $(LDFLAGS) -c $< -o $@

build/collector-allocation-test: build/collector-allocation-test.o $(SQLITE_OBJECT) build/compiler_ok Makefile build/build_options
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(if $(SANITIZER),,-static-libstdc++ -static-libgcc) $(LDLIBS) $(COLLECTOR_LIBS) -o $@

build/collector-test.o: tests/collector_test.cpp $(COLLECTOR_HEADERS) $(COMMON_HEADERS) build/compiler_ok Makefile
	mkdir -p build
	$(COMPILER_CACHE) $(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 -pthread $(LDFLAGS) -c $< -o $@

build/collector-test: build/collector-test.o $(SQLITE_OBJECT) build/compiler_ok Makefile build/build_options
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) -Wl,--wrap=fsync $(LDLIBS) $(COLLECTOR_LIBS) -o $@

CPP_TESTS := build/wire-test build/sampler-test build/allocation-test build/collector-allocation-test build/collector-test
dashboard-check: dashboard/node_modules/.package-lock.json
	cd dashboard && npm run check

# Optional: tri-scout, the read-only MCP tools for an LLM client (REQ-0001).
# all and release do not build it, so a deploy without it has no AI part.
scout: dashboard/node_modules/.package-lock.json
	cd dashboard && npm run build:scout

check: dashboard-check all build/buggy-workload build/benchmark-target build/benchmark-victim build/benchmark-sampling $(CPP_TESTS)
	python3 tests/run_checks.py $(CPP_TESTS)

check-asan:
	$(MAKE) check SANITIZER=address

check-tsan:
	$(MAKE) check SANITIZER=thread

# Run sequentially, including with make -j: both modes use build/.
check-sanitizers:
	$(MAKE) check-asan
	$(MAKE) check-tsan

build/benchmark-target.o: tests/benchmark_target.cpp tests/runtime_threads.hpp build/compiler_ok Makefile
	mkdir -p build
	$(COMPILER_CACHE) $(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 -pthread $(LDFLAGS) -c $< -o $@

build/benchmark-target: build/benchmark-target.o build/compiler_ok Makefile build/build_options
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -pthread -o $@

build/benchmark-victim.o: tests/benchmark_victim.cpp tests/runtime_threads.hpp build/compiler_ok Makefile
	mkdir -p build
	$(COMPILER_CACHE) $(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 -pthread $(LDFLAGS) -c $< -o $@

build/benchmark-victim: build/benchmark-victim.o build/compiler_ok Makefile build/build_options
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -pthread -o $@

# How much the sampler disturbs a target: stalls, wake-up lateness, lock waits.
# Needs six CPUs; see tests/benchmark_target_impact.py for the options.
.PHONY: benchmark-target-impact
benchmark-target-impact: build/triangulator-sampler build/benchmark-victim
	python3 tests/benchmark_target_impact.py

# Three 30-second trials per count/rate pair, after a 5-second warm-up.
.PHONY: benchmark-sampler-matrix
benchmark-sampler-matrix: build/triangulator-sampler build/benchmark-target
	python3 tests/benchmark_sampler.py --threads 100 300 500 --duration 30 --output build/sampler-benchmark.json

build/benchmark-sampling.o: tests/benchmark_sampling.cpp $(SAMPLER_HEADERS) $(COMMON_HEADERS) build/compiler_ok Makefile
	mkdir -p build
	$(COMPILER_CACHE) $(CXX) $(CPPFLAGS) $(CXXFLAGS) $(SAMPLER_LDFLAGS) -std=c++23 -pthread $(LDFLAGS) -c $< -o $@

build/benchmark-sampling: build/benchmark-sampling.o build/compiler_ok Makefile build/build_options
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(SAMPLER_LDFLAGS) $(LDLIBS) -o $@

.PHONY: benchmark-sampling
benchmark-sampling: build/benchmark-sampling build/benchmark-target
	python3 tests/benchmark_sampling.py

# Cost of one resource sample and one memory-map sample, from the production
# probes, for three target shapes.
.PHONY: benchmark-slow-samples
benchmark-slow-samples: build/benchmark-sampling build/benchmark-victim
	python3 tests/benchmark_slow_samples.py

format: dashboard/node_modules/.package-lock.json
	cd dashboard && npm run format
	$(CLANG_FORMAT) -i $(CPP_SOURCES)

format-check:
	$(CLANG_FORMAT) --dry-run --Werror $(CPP_SOURCES)

clean:
	rm -rf build dashboard/dist

# The deliberate bugs stay separate from the production programs.
build/buggy-workload.o: examples/buggy-workload/buggy_workload.cpp build/compiler_ok Makefile
	mkdir -p build
	$(COMPILER_CACHE) $(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 -pthread $(LDFLAGS) -c $< -o $@

build/buggy-workload: build/buggy-workload.o build/compiler_ok Makefile build/build_options
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -pthread -o $@
