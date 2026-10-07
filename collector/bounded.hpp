#pragma once

// Containers whose storage is allocated once, at construction. Nothing here
// allocates after that, so code on the datagram path can use them. The
// collector's memory rule is the sampler's: allocate at startup only (see
// docs/tigerstyle-adaption.md).

#include <algorithm>
#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <new>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace triangulator::collector
{

// A std::vector whose capacity is reserved at construction and never grows.
// reserve() asks the allocator for address space but writes nothing to it,
// so the operating system gives physical pages only as elements are
// constructed. A large bound therefore costs little until it is used.
//
// Every function that adds an element returns false (or does nothing) when
// the vector is full. The caller decides what a full vector means; it is
// always a limit that the caller documents.
template <typename T>
class BoundedVector
{
 public:
  BoundedVector() = default;
  explicit BoundedVector(std::size_t p_capacity)
  {
    items_.reserve(p_capacity);
  }
  // A copy of a std::vector has a capacity of only its size, so a copy would
  // be full. A move keeps the capacity.
  BoundedVector(const BoundedVector&) = delete;
  BoundedVector& operator=(const BoundedVector&) = delete;
  BoundedVector(BoundedVector&&) noexcept = default;
  BoundedVector& operator=(BoundedVector&&) noexcept = default;
  ~BoundedVector() = default;

  [[nodiscard]] std::size_t Capacity() const noexcept
  {
    return items_.capacity();
  }
  [[nodiscard]] std::size_t Size() const noexcept
  {
    return items_.size();
  }
  [[nodiscard]] bool Empty() const noexcept
  {
    return items_.empty();
  }
  [[nodiscard]] bool Full() const noexcept
  {
    return items_.size() == items_.capacity();
  }

  [[nodiscard]] bool PushBack(T p_item)
  {
    if (Full())
    {
      return false;
    }
    items_.push_back(std::move(p_item));
    return true;
  }

  // Inserts before p_position. Returns false when full.
  [[nodiscard]] bool Insert(std::size_t p_position, T p_item)
  {
    assert(p_position <= items_.size());
    if (Full())
    {
      return false;
    }
    items_.insert(items_.begin() + static_cast<std::ptrdiff_t>(p_position),
                  std::move(p_item));
    return true;
  }

  void Erase(std::size_t p_position) noexcept
  {
    assert(p_position < items_.size());
    items_.erase(items_.begin() + static_cast<std::ptrdiff_t>(p_position));
  }

  void PopBack() noexcept
  {
    assert(!items_.empty());
    items_.pop_back();
  }

  void Clear() noexcept
  {
    items_.clear();
  }

  // Keeps the first p_size items.
  void Truncate(std::size_t p_size) noexcept
  {
    assert(p_size <= items_.size());
    items_.erase(items_.begin() + static_cast<std::ptrdiff_t>(p_size),
                 items_.end());
  }

  [[nodiscard]] T& operator[](std::size_t p_index) noexcept
  {
    assert(p_index < items_.size());
    return items_[p_index];
  }
  [[nodiscard]] const T& operator[](std::size_t p_index) const noexcept
  {
    assert(p_index < items_.size());
    return items_[p_index];
  }
  [[nodiscard]] T& Back() noexcept
  {
    return items_.back();
  }

  [[nodiscard]] auto begin() noexcept
  {
    return items_.begin();
  }
  [[nodiscard]] auto end() noexcept
  {
    return items_.end();
  }
  [[nodiscard]] auto begin() const noexcept
  {
    return items_.begin();
  }
  [[nodiscard]] auto end() const noexcept
  {
    return items_.end();
  }

 private:
  std::vector<T> items_;
};

// An array of p_count zeroed T. calloc gets zeroed pages from the operating
// system without writing to them, so a large, sparsely used table costs
// only the pages that code touches. (std::vector's constructor would write
// every element.) T must be a type for which all-zero bytes are a valid
// value. Throws std::bad_alloc at construction if the memory is not
// available.
template <typename T>
class ZeroedArray
{
  static_assert(std::is_trivial_v<T>);

 public:
  explicit ZeroedArray(std::size_t p_count)
      : data_(static_cast<T*>(std::calloc(p_count, sizeof(T)))), size_(p_count)
  {
    if (data_ == nullptr)
    {
      throw std::bad_alloc{};
    }
  }

  [[nodiscard]] std::size_t Size() const noexcept
  {
    return size_;
  }
  [[nodiscard]] T& operator[](std::size_t p_index) noexcept
  {
    assert(p_index < size_);
    return data_[p_index];
  }

 private:
  struct Free
  {
    void operator()(T* p_data) const noexcept
    {
      std::free(p_data);
    }
  };
  std::unique_ptr<T[], Free> data_;
  std::size_t size_;
};

// The newest p_capacity items of a stream, oldest first. Adding to a full
// ring drops the oldest item. The storage is a fixed array.
template <typename T, std::size_t TCapacity>
class Ring
{
 public:
  void PushBack(T p_item) noexcept
  {
    items_[(first_ + size_) % TCapacity] = std::move(p_item);
    if (size_ == TCapacity)
    {
      first_ = (first_ + 1) % TCapacity;
    }
    else
    {
      ++size_;
    }
  }

  [[nodiscard]] bool Empty() const noexcept
  {
    return size_ == 0;
  }
  [[nodiscard]] std::size_t Size() const noexcept
  {
    return size_;
  }
  [[nodiscard]] const T& Front() const noexcept
  {
    return items_[first_];
  }
  void PopFront() noexcept
  {
    assert(size_ > 0);
    first_ = (first_ + 1) % TCapacity;
    --size_;
  }
  void Clear() noexcept
  {
    first_ = 0;
    size_ = 0;
  }
  // p_index 0 is the oldest item.
  [[nodiscard]] const T& operator[](std::size_t p_index) const noexcept
  {
    assert(p_index < size_);
    return items_[(first_ + p_index) % TCapacity];
  }

 private:
  std::array<T, TCapacity> items_{};
  std::size_t first_ = 0;
  std::size_t size_ = 0;
};

// Text of at most TCapacity bytes in the object itself. Assign() cuts longer
// text at TCapacity; callers choose a capacity that fits what they store.
template <std::size_t TCapacity>
class FixedText
{
 public:
  FixedText() = default;
  explicit FixedText(std::string_view p_text) noexcept
  {
    Assign(p_text);
  }

  FixedText& operator=(std::string_view p_text) noexcept
  {
    Assign(p_text);
    return *this;
  }

  void Assign(std::string_view p_text) noexcept
  {
    size_ = std::min(p_text.size(), TCapacity);
    std::copy_n(p_text.begin(), size_, bytes_.begin());
  }

  // Appends as much of p_text as fits. Returns false if some was cut.
  bool Append(std::string_view p_text) noexcept
  {
    const auto room = TCapacity - size_;
    const auto count = std::min(p_text.size(), room);
    std::copy_n(p_text.begin(), count, bytes_.begin() + size_);
    size_ += count;
    return count == p_text.size();
  }

  void Clear() noexcept
  {
    size_ = 0;
  }
  // Keeps the first p_size bytes.
  void Truncate(std::size_t p_size) noexcept
  {
    assert(p_size <= size_);
    size_ = p_size;
  }
  [[nodiscard]] std::string_view View() const noexcept
  {
    return {bytes_.data(), size_};
  }
  [[nodiscard]] bool Empty() const noexcept
  {
    return size_ == 0;
  }
  [[nodiscard]] bool operator==(const FixedText& p_other) const noexcept
  {
    return View() == p_other.View();
  }
  // For comparisons and for building JSON and SQL values.
  [[nodiscard]] operator std::string_view() const noexcept
  {
    return View();
  }

 private:
  std::array<char, TCapacity> bytes_{};
  std::size_t size_ = 0;
};

}  // namespace triangulator::collector
