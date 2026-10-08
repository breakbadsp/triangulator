# Builds the sample program with deliberate resource bugs into ../../build.
CXX ?= c++
CXXFLAGS ?= -O2 -Wall -Wextra -Werror -Wconversion -Wshadow

../../build/buggy-workload: buggy_workload.cpp
	mkdir -p ../../build
	$(CXX) -std=c++23 $(CXXFLAGS) -pthread $< -o $@
