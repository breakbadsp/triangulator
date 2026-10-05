#pragma once

#include <unistd.h>

#include <utility>

namespace triangulator
{

// Owns a POSIX file descriptor and closes it on destruction.
class FileDescriptor final
{
 public:
  FileDescriptor() = default;
  explicit FileDescriptor(int p_descriptor) noexcept : descriptor_(p_descriptor)
  {
  }
  ~FileDescriptor()
  {
    Reset();
  }
  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;
  FileDescriptor(FileDescriptor&& p_other) noexcept
      : descriptor_(std::exchange(p_other.descriptor_, -1))
  {
  }
  FileDescriptor& operator=(FileDescriptor&& p_other) noexcept
  {
    if (this != &p_other)
    {
      Reset(std::exchange(p_other.descriptor_, -1));
    }
    return *this;
  }
  [[nodiscard]] int Get() const noexcept
  {
    return descriptor_;
  }
  [[nodiscard]] explicit operator bool() const noexcept
  {
    return descriptor_ >= 0;
  }
  void Reset(int p_descriptor = -1) noexcept
  {
    if (descriptor_ >= 0)
    {
      ::close(descriptor_);
    }
    descriptor_ = p_descriptor;
  }

 private:
  int descriptor_ = -1;
};

}  // namespace triangulator
