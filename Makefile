CXX ?= c++
CXXFLAGS ?= -O2 -Wall -Wextra -Werror -Wconversion -Wshadow
CPPFLAGS ?=
LDFLAGS ?=
LDLIBS ?=
CLANG_FORMAT ?= clang-format
SAMPLER_HEADERS := $(wildcard sampler/*.hpp)
COMMON_HEADERS := $(wildcard common/*.hpp)
COLLECTOR_HEADERS := $(wildcard collector/*.hpp)
COLLECTOR_LIBS ?= -lsqlite3
SOCKET_HEADERS := $(wildcard socket_sampler/*.hpp)
METRICS_HEADERS := $(wildcard metrics/*.hpp)
CPP_SOURCES := $(COMMON_HEADERS) sampler/main.cpp $(SAMPLER_HEADERS) tests/sampler_test.cpp \
	collector/main.cpp $(COLLECTOR_HEADERS) tests/collector_test.cpp \
	tests/wire_test.cpp tests/socket_metrics_test.cpp tests/socket_target.cpp \
	$(SOCKET_HEADERS) socket_sampler/main.cpp socket_sampler/socket.bpf.cpp \
	$(METRICS_HEADERS) metrics/main.cpp

.PHONY: all check clean format format-check
all: build/triangulator-sampler build/triangulator-collector build/triangulator-socket-report

build/triangulator-sampler: sampler/main.cpp $(SAMPLER_HEADERS) $(COMMON_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

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

build/triangulator-collector: collector/main.cpp $(COLLECTOR_HEADERS) $(COMMON_HEADERS) $(SOCKET_HEADERS) sampler/parsing.hpp build/dashboard_html.inc Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) -Ibuild $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) $(COLLECTOR_LIBS) -o $@

build/sampler-test: tests/sampler_test.cpp $(SAMPLER_HEADERS) $(COMMON_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

build/wire-test: tests/wire_test.cpp $(COMMON_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

build/collector-test: tests/collector_test.cpp $(COLLECTOR_HEADERS) $(COMMON_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) $(COLLECTOR_LIBS) -o $@

check: all build/wire-test build/sampler-test build/collector-test build/socket-metrics-test
	./build/wire-test
	./build/sampler-test
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

build/socket-metrics-test: tests/socket_metrics_test.cpp $(SOCKET_HEADERS) $(METRICS_HEADERS) $(COLLECTOR_HEADERS) $(SAMPLER_HEADERS) $(COMMON_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) $(COLLECTOR_LIBS) -o $@

build/socket-target: tests/socket_target.cpp $(COMMON_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -pthread -rdynamic -o $@

.PHONY: check-socket-kernel
check-socket-kernel: all socket-sampler build/socket-target
	TRIANGULATOR_BPF_TESTS=1 python3 -m unittest discover -s tests -p test_socket_kernel.py -v

build/triangulator-socket-report: metrics/main.cpp $(METRICS_HEADERS) $(SOCKET_HEADERS) $(COLLECTOR_HEADERS) $(SAMPLER_HEADERS) $(COMMON_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) $(COLLECTOR_LIBS) -o $@
