# Choose the compiler from outside; never edit this file for it:
#   make CXX=g++-14        or        CXX=clang++-19 make
# GNU Make predefines CXX as g++, so "?=" never applies; test the origin.
ifeq ($(origin CXX),default)
CXX := c++
endif
CXXFLAGS ?= -O2 -Wall -Wextra -Werror -Wconversion -Wshadow
CPPFLAGS ?=
LDFLAGS ?=
LDLIBS ?=
READELF ?= readelf
# The production-host sampler always needs only the kernel. Other programs
# embed the C++ runtime; STATIC=1 also embeds libc and SQLite.
STATIC ?= 0
SAMPLER_LDFLAGS ?= -static
RUNTIME_LDFLAGS ?= -static-libstdc++ -static-libgcc
ifeq ($(STATIC),1)
RUNTIME_LDFLAGS := -static
endif
# Optional local SQLite amalgamation: no download or vendored source required.
# It is compiled as C with $(CXX) -x c, so no separate C compiler setting exists.
SQLITE_SOURCE ?=
SQLITE_CFLAGS ?= -O2
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
SOCKET_HEADERS := $(wildcard socket_sampler/*.hpp)
METRICS_HEADERS := $(wildcard metrics/*.hpp)
CPP_SOURCES := examples/buggy-workload/buggy_workload.cpp $(COMMON_HEADERS) sampler/main.cpp $(SAMPLER_HEADERS) tests/sampler_test.cpp tests/allocation_test.cpp \
	collector/main.cpp $(COLLECTOR_HEADERS) tests/collector_test.cpp tests/collector_allocation_test.cpp \
	tests/wire_test.cpp tests/socket_metrics_test.cpp tests/socket_target.cpp \
	$(SOCKET_HEADERS) socket_sampler/main.cpp socket_sampler/socket.bpf.cpp \
	$(METRICS_HEADERS) metrics/main.cpp

.PHONY: all check clean format format-check release sqlite-amalgamation FORCE
all: build/triangulator-sampler build/triangulator-collector build/triangulator-socket-report

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

build/sqlite3.o: $(SQLITE_SOURCE) $(SQLITE_HEADER) build/compiler_ok Makefile
	$(CXX) -x c $(CPPFLAGS) $(SQLITE_CFLAGS) -DSQLITE_OMIT_LOAD_EXTENSION -c $< -o $@

# Optional download of the SQLite amalgamation for fully static builds. Nothing
# else in this Makefile uses the network. The script checks the published hash.
sqlite-amalgamation:
	python3 -I scripts/fetch-sqlite.py build/sqlite

# Stop early, with a clear message, if the compiler lacks C++23 library support.
# The stamp is renewed only when build_options changes (compiler or flags).
build/compiler_ok: build/build_options
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
	@for binary in build/triangulator-sampler build/triangulator-collector build/triangulator-socket-report; do \
		$(READELF) -lW "$$binary" > build/release_segments.tmp || exit 1; \
		$(READELF) -dW "$$binary" > build/release_dynamic.tmp || exit 1; \
		if grep -Eq 'INTERP|NEEDED' build/release_segments.tmp build/release_dynamic.tmp; then \
			echo "release binary has dynamic dependencies: $$binary" >&2; exit 1; \
		fi; \
	done
	@rm -f build/release_segments.tmp build/release_dynamic.tmp

build/triangulator-sampler: sampler/main.cpp $(SAMPLER_HEADERS) $(COMMON_HEADERS) build/compiler_ok Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(SAMPLER_LDFLAGS) $(LDLIBS) -o $@

# The collector embeds collector/dashboard.html, so the binary serves the
# page without reading files at run time. od writes the page's bytes as a
# comma-separated list that collector/http.hpp includes. (C++26 #embed does
# the same but needs GCC 15 or Clang 19; this works with any C++23 compiler.)
build/dashboard_html.inc: collector/dashboard.html Makefile
	mkdir -p build
	od -An -v -tu1 $< > $@.od
	sed 's/^ *//; s/ *$$//; s/  */,/g; s/$$/,/' $@.od > $@.tmp
	mv $@.tmp $@
	rm -f $@.od

build/triangulator-collector: collector/main.cpp $(COLLECTOR_HEADERS) $(COMMON_HEADERS) $(SOCKET_HEADERS) sampler/parsing.hpp build/dashboard_html.inc $(SQLITE_OBJECT) build/compiler_ok Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) -Ibuild $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(RUNTIME_LDFLAGS) $(LDLIBS) $(COLLECTOR_LIBS) -o $@

build/sampler-test: tests/sampler_test.cpp $(SAMPLER_HEADERS) $(COMMON_HEADERS) build/compiler_ok Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

# Static, so --wrap also counts allocations made inside libc and libstdc++.
build/allocation-test: tests/allocation_test.cpp $(SAMPLER_HEADERS) $(COMMON_HEADERS) build/compiler_ok Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(SAMPLER_LDFLAGS) \
		-Wl,--wrap=malloc,--wrap=calloc,--wrap=realloc $(LDLIBS) -o $@

build/wire-test: tests/wire_test.cpp $(COMMON_HEADERS) build/compiler_ok Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

# Dynamic libc, so the test's own malloc replaces libc's for every library
# (see the test). Not static, unlike build/allocation-test.
build/collector-allocation-test: tests/collector_allocation_test.cpp $(COLLECTOR_HEADERS) $(COMMON_HEADERS) $(SOCKET_HEADERS) $(SQLITE_OBJECT) build/compiler_ok Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) -static-libstdc++ -static-libgcc $(LDLIBS) $(COLLECTOR_LIBS) -o $@

build/collector-test: tests/collector_test.cpp $(COLLECTOR_HEADERS) $(COMMON_HEADERS) $(SQLITE_OBJECT) build/compiler_ok Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) $(COLLECTOR_LIBS) -o $@

check: all build/wire-test build/sampler-test build/allocation-test build/collector-allocation-test build/collector-test build/socket-metrics-test
	./build/wire-test
	./build/sampler-test
	./build/allocation-test
	./build/collector-allocation-test
	./build/collector-test
	./build/socket-metrics-test
	python3 -m unittest discover -s tests -v

format:
	$(CLANG_FORMAT) -i $(CPP_SOURCES)

format-check:
	$(CLANG_FORMAT) --dry-run --Werror $(CPP_SOURCES)

clean:
	rm -rf build

# Optional privileged source; the normal proc sampler stays dependency-free.
BPF_CXX ?= clang++
.PHONY: socket-sampler
socket-sampler: build/triangulator-socket-sampler build/socket.bpf.o

build/socket.bpf.o: socket_sampler/socket.bpf.cpp socket_sampler/shared.hpp Makefile
	mkdir -p build
	$(BPF_CXX) -target bpf -std=c++20 -O2 -g -fno-exceptions -fno-rtti -fno-unwind-tables -fno-asynchronous-unwind-tables -Wall -Wextra -Werror -c $< -o $@

build/triangulator-socket-sampler: socket_sampler/main.cpp $(SOCKET_HEADERS) $(SAMPLER_HEADERS) $(COLLECTOR_HEADERS) $(COMMON_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -lbpf -o $@

build/socket-metrics-test: tests/socket_metrics_test.cpp $(SOCKET_HEADERS) $(METRICS_HEADERS) $(COLLECTOR_HEADERS) $(SAMPLER_HEADERS) $(COMMON_HEADERS) $(SQLITE_OBJECT) build/compiler_ok Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) $(COLLECTOR_LIBS) -o $@

build/socket-target: tests/socket_target.cpp $(COMMON_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -pthread -rdynamic -o $@

.PHONY: check-socket-kernel
check-socket-kernel: all socket-sampler build/socket-target
	TRIANGULATOR_BPF_TESTS=1 python3 -m unittest discover -s tests -p test_socket_kernel.py -v

build/triangulator-socket-report: metrics/main.cpp $(METRICS_HEADERS) $(SOCKET_HEADERS) $(COLLECTOR_HEADERS) $(SAMPLER_HEADERS) $(COMMON_HEADERS) $(SQLITE_OBJECT) build/compiler_ok Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(RUNTIME_LDFLAGS) $(LDLIBS) $(COLLECTOR_LIBS) -o $@
