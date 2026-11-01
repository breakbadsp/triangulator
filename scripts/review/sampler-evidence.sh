#!/usr/bin/env bash
# Demonstrate that a directory read error is returned as end of directory.
set -eu
cd "$(dirname "$0")/../.."
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
cat > "$tmp_dir/probe.cpp" <<'CPP'
#include <cerrno>
#include <cstdio>
#include <unistd.h>
#include "sampler/io.hpp"
int main()
{
  triangulator::Directory directory{"/proc"};
  if (!directory || ::close(directory.Fd()) != 0)
  {
    return 1;
  }
  errno = 0;
  const auto entry = directory.Next();
  if (entry || errno != EBADF)
  {
    return 1;
  }
  std::puts("getdents64 returned EBADF; Directory::Next returned no entry");
}
CPP
"${CXX:-c++}" -std=c++23 -I. "$tmp_dir/probe.cpp" -o "$tmp_dir/probe"
"$tmp_dir/probe"
