#pragma once

// SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104), for the memory-map
// request channel. The sampler must stay a static binary with no library
// beyond the kernel, so it cannot link a crypto library; both functions are
// short enough to keep here. tests/wire_test.cpp checks them against the
// published test vectors. This header depends only on the standard library.

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <span>

namespace triangulator
{

using Sha256Digest = std::array<std::uint8_t, 32>;

class Sha256 final
{
 public:
  void Update(std::span<const std::uint8_t> p_data) noexcept
  {
    for (const auto byte : p_data)
    {
      block_[block_bytes_++] = byte;
      if (block_bytes_ == block_.size())
      {
        Compress();
        block_bytes_ = 0;
      }
    }
    total_bytes_ += p_data.size();
  }

  [[nodiscard]] Sha256Digest Finish() noexcept
  {
    const std::uint64_t total_bits = total_bytes_ * 8;
    constexpr std::array<std::uint8_t, 1> kEnd{0x80};
    Update(kEnd);
    constexpr std::array<std::uint8_t, 1> kZero{0};
    while (block_bytes_ != 56)
    {
      Update(kZero);
    }
    std::array<std::uint8_t, 8> length{};
    for (std::size_t index = 0; index < length.size(); ++index)
    {
      length[index] = static_cast<std::uint8_t>(total_bits >> (56 - 8 * index));
    }
    Update(length);
    Sha256Digest digest{};
    for (std::size_t word = 0; word < state_.size(); ++word)
    {
      for (std::size_t byte = 0; byte < 4; ++byte)
      {
        digest[word * 4 + byte] =
            static_cast<std::uint8_t>(state_[word] >> (24 - 8 * byte));
      }
    }
    return digest;
  }

 private:
  static constexpr std::array<std::uint32_t, 64> kRound{
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

  void Compress() noexcept
  {
    std::array<std::uint32_t, 64> schedule{};
    for (std::size_t index = 0; index < 16; ++index)
    {
      schedule[index] = std::uint32_t{block_[index * 4]} << 24 |
                        std::uint32_t{block_[index * 4 + 1]} << 16 |
                        std::uint32_t{block_[index * 4 + 2]} << 8 |
                        std::uint32_t{block_[index * 4 + 3]};
    }
    for (std::size_t index = 16; index < schedule.size(); ++index)
    {
      const auto low = schedule[index - 15];
      const auto high = schedule[index - 2];
      const auto sigma0 = std::rotr(low, 7) ^ std::rotr(low, 18) ^ (low >> 3);
      const auto sigma1 =
          std::rotr(high, 17) ^ std::rotr(high, 19) ^ (high >> 10);
      schedule[index] =
          schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1;
    }
    auto [a, b, c, d, e, f, g, h] = state_;
    for (std::size_t index = 0; index < schedule.size(); ++index)
    {
      const auto sum1 = std::rotr(e, 6) ^ std::rotr(e, 11) ^ std::rotr(e, 25);
      const auto choose = (e & f) ^ (~e & g);
      const auto first = h + sum1 + choose + kRound[index] + schedule[index];
      const auto sum0 = std::rotr(a, 2) ^ std::rotr(a, 13) ^ std::rotr(a, 22);
      const auto majority = (a & b) ^ (a & c) ^ (b & c);
      const auto second = sum0 + majority;
      h = g;
      g = f;
      f = e;
      e = d + first;
      d = c;
      c = b;
      b = a;
      a = first + second;
    }
    const std::array<std::uint32_t, 8> add{a, b, c, d, e, f, g, h};
    for (std::size_t index = 0; index < state_.size(); ++index)
    {
      state_[index] += add[index];
    }
  }

  std::array<std::uint32_t, 8> state_{0x6a09e667, 0xbb67ae85, 0x3c6ef372,
                                      0xa54ff53a, 0x510e527f, 0x9b05688c,
                                      0x1f83d9ab, 0x5be0cd19};
  std::array<std::uint8_t, 64> block_{};
  std::size_t block_bytes_ = 0;
  std::uint64_t total_bytes_ = 0;
};

[[nodiscard]] inline Sha256Digest Sha256Of(
    std::span<const std::uint8_t> p_data) noexcept
{
  Sha256 hash;
  hash.Update(p_data);
  return hash.Finish();
}

// HMAC-SHA256 of p_message with p_key (RFC 2104).
[[nodiscard]] inline Sha256Digest HmacSha256(
    std::span<const std::uint8_t> p_key,
    std::span<const std::uint8_t> p_message) noexcept
{
  constexpr std::size_t kBlockBytes = 64;
  std::array<std::uint8_t, kBlockBytes> key{};
  if (p_key.size() > kBlockBytes)
  {
    const auto digest = Sha256Of(p_key);
    std::ranges::copy(digest, key.begin());
  }
  else
  {
    std::ranges::copy(p_key, key.begin());
  }
  std::array<std::uint8_t, kBlockBytes> inner_pad{};
  std::array<std::uint8_t, kBlockBytes> outer_pad{};
  for (std::size_t index = 0; index < kBlockBytes; ++index)
  {
    inner_pad[index] = static_cast<std::uint8_t>(key[index] ^ 0x36);
    outer_pad[index] = static_cast<std::uint8_t>(key[index] ^ 0x5c);
  }
  Sha256 inner;
  inner.Update(inner_pad);
  inner.Update(p_message);
  const auto inner_digest = inner.Finish();
  Sha256 outer;
  outer.Update(outer_pad);
  outer.Update(inner_digest);
  return outer.Finish();
}

// Compares two digests in a time that does not depend on where they differ,
// so a sender cannot find a valid MAC one byte at a time.
[[nodiscard]] inline bool EqualDigests(const Sha256Digest& p_left,
                                       const Sha256Digest& p_right) noexcept
{
  std::uint8_t difference = 0;
  for (std::size_t index = 0; index < p_left.size(); ++index)
  {
    difference = static_cast<std::uint8_t>(difference |
                                           (p_left[index] ^ p_right[index]));
  }
  return difference == 0;
}

}  // namespace triangulator
