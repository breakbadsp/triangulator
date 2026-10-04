CXX ?= c++
CXXFLAGS ?= -O2 -Wall -Wextra -Werror -Wconversion -Wshadow
CPPFLAGS ?=
LDFLAGS ?=
LDLIBS ?=
SAMPLER_HEADERS := $(wildcard sampler/*.hpp)

.PHONY: all check clean
all: build/triangulator-sampler

build/triangulator-sampler: sampler/main.cpp $(SAMPLER_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

build/sampler-test: tests/sampler_test.cpp $(SAMPLER_HEADERS) Makefile
	mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++23 $< $(LDFLAGS) $(LDLIBS) -o $@

check: all build/sampler-test
	./build/sampler-test
	python3 -m unittest discover -s tests -v

clean:
	rm -rf build
