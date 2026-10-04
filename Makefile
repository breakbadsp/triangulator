CXX ?= c++
CXXFLAGS ?= -O2 -Wall -Wextra -Werror -Wconversion -Wshadow
CPPFLAGS ?=
LDFLAGS ?=
LDLIBS ?=
CLANG_FORMAT ?= clang-format
SAMPLER_HEADERS := $(wildcard sampler/*.hpp)
COLLECTOR_HEADERS := $(wildcard collector/*.hpp)
COLLECTOR_LIBS ?= -lsqlite3
CPP_SOURCES := sampler/main.cpp $(SAMPLER_HEADERS) tests/sampler_test.cpp \
	collector/main.cpp $(COLLECTOR_HEADERS)

.PHONY: all check clean format format-check
all: build/triangulator-sampler build/triangulator-collector

build/triangulator-sampler: sampler/main.cpp $(SAMPLER_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

# The C++ port of the Python collector. It embeds triangulator/dashboard.html,
# so both collectors serve the same page.
build/triangulator-collector: collector/main.cpp $(COLLECTOR_HEADERS) $(SAMPLER_HEADERS) triangulator/dashboard.html Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) $(COLLECTOR_LIBS) -o $@

build/sampler-test: tests/sampler_test.cpp $(SAMPLER_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

check: all build/sampler-test
	./build/sampler-test
	python3 -m unittest discover -s tests -v

format:
	$(CLANG_FORMAT) -i $(CPP_SOURCES)

format-check:
	$(CLANG_FORMAT) --dry-run --Werror $(CPP_SOURCES)

clean:
	rm -rf build
