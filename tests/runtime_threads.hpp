#pragma once

#include <unistd.h>

#include <filesystem>
#include <string>
#include <thread>

namespace triangulator
{

// Sanitizer runtimes can start a persistent thread on the first thread
// creation. Reserve its slot so benchmark targets retain their native count.
inline int RuntimeThreadCount(bool p_warm_up)
{
#ifdef TRIANGULATOR_SANITIZER
  if (!p_warm_up)
  {
    return 0;
  }
  pid_t warmup_tid = 0;
  {
    std::jthread warmup(
        [tid = &warmup_tid]
        {
          *tid = ::gettid();
        });
  }
  // A joined thread can remain in /proc until the kernel finishes its exit.
  const auto warmup_name = std::to_string(warmup_tid);
  int count = 0;
  for (const auto& task :
       std::filesystem::directory_iterator("/proc/self/task"))
  {
    if (task.path().filename() != warmup_name && task.is_directory())
    {
      ++count;
    }
  }
  return count - 1;
#else
  static_cast<void>(p_warm_up);
  return 0;
#endif
}

}  // namespace triangulator
