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
CPP_SOURCES := $(COMMON_HEADERS) sampler/main.cpp $(SAMPLER_HEADERS) tests/sampler_test.cpp \
	collector/main.cpp $(COLLECTOR_HEADERS) tests/collector_test.cpp \
	tests/wire_test.cpp

.PHONY: all check clean format format-check
all: build/triangulator-sampler build/triangulator-collector

build/triangulator-sampler: sampler/main.cpp $(SAMPLER_HEADERS) $(COMMON_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

# The collector embeds collector/dashboard.html, so the binary serves the
# page without reading files at run time.
build/triangulator-collector: collector/main.cpp $(COLLECTOR_HEADERS) $(COMMON_HEADERS) collector/dashboard.html Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) $(COLLECTOR_LIBS) -o $@

build/sampler-test: tests/sampler_test.cpp $(SAMPLER_HEADERS) $(COMMON_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

build/wire-test: tests/wire_test.cpp $(COMMON_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

build/collector-test: tests/collector_test.cpp $(COLLECTOR_HEADERS) $(COMMON_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) $(COLLECTOR_LIBS) -o $@

check: all build/wire-test build/sampler-test build/collector-test
	./build/wire-test
	./build/sampler-test
	./build/collector-test
	python3 -m unittest discover -s tests -v

format:
	$(CLANG_FORMAT) -i $(CPP_SOURCES)

format-check:
	$(CLANG_FORMAT) --dry-run --Werror $(CPP_SOURCES)

clean:
	rm -rf build
