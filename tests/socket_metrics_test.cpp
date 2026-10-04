#include <cassert>
#include <iostream>

#include "../metrics/socket_report.hpp"

namespace
{
using namespace triangulator::socket_metrics;
using triangulator::collector::Json;

Observation Header(U64 p_sequence, U32 p_count = 2)
{
  return {.observer_ = 99,
          .sequence_ = p_sequence,
          .monotonic_ns_ = (p_sequence + 10) * 1000000000ULL,
          .wall_ns_ = (p_sequence + 1700000000) * 1000000000ULL,
          .started_ns_ = 10000000000ULL,
          .process_start_ = 123,
          .pid_ = 50,
          .count_ = p_count,
          .flags_ = kMessageEnabled};
}
Snapshot Sample(U64 p_sequence, U64 p_bytes, U64 p_messages = 0)
{
  Snapshot snapshot;
  auto value = Header(p_sequence, 3);
  snapshot.Add(value, 100 + static_cast<double>(p_sequence));
  value.index_ = 1;
  value.key_ = {123000, 777, 51, 1};
  value.counters_ = {p_bytes, p_bytes / 2, p_sequence, p_sequence, 0};
  snapshot.Add(value, 100 + static_cast<double>(p_sequence));
  value.index_ = 2;
  value.key_ = {123000, 0, 51, 6};
  value.counters_ = {0, 0, 0, 0, p_messages};
  snapshot.Add(value, 100 + static_cast<double>(p_sequence));
  return snapshot;
}
const Json& Get(const Json& p_json, std::string_view p_name)
{
  const auto* value = p_json.Find(p_name);
  assert(value);
  return *value;
}
const Json& Metric(const Json& p_json, std::string_view p_metric,
                   std::string_view p_field)
{
  return Get(Get(Get(p_json, "totals"), p_metric), p_field);
}

void Protocol()
{
  auto value = Header(1);
  assert(Decode(Encode(value)));
  value.index_ = 1;
  value.key_ = {123, 456, 51, 5};
  value.counters_.input_ = 18446744073709551615ULL;
  auto encoded = Encode(value);
  assert(Decode(encoded)->counters_.input_ == value.counters_.input_);
  assert(!Decode(std::span{encoded}.first(159)));
  encoded[4] = std::byte{2};
  assert(!Decode(encoded));
  value.key_.kind_ = 7;
  assert(!Decode(Encode(value)));
  value.key_.kind_ = 6;
  assert(!Decode(Encode(value)));  // a marker cannot carry a socket / bytes
  value = Header(1);
  value.count_ = kMaxSocketCounters + 2;
  assert(!Decode(Encode(value)));
  value = Header(1);
  value.monotonic_ns_ = 1;
  assert(!Decode(Encode(value)));
  value = Header(1);
  value.index_ = value.count_;
  assert(!Decode(Encode(value)));
}

void Reporting()
{
  std::map<U64, Snapshot> samples{
      {0, Sample(0, 0)}, {1, Sample(1, 100, 3)}, {2, Sample(2, 100, 3)}};
  auto result = Report(samples, 102, false);
  assert(Metric(result, "input", "total").AsString() == "100");
  assert(Metric(result, "input", "average").AsNumber() == 50);
  assert(Metric(result, "input", "minimum").AsNumber() == 0);
  assert(Metric(result, "input", "maximum").AsNumber() == 100);
  assert(Metric(result, "messages", "total").AsString() == "3");
  assert(Get(result, "rate_windows").AsInt() == 2);
  // Lost datagrams do not destroy cumulative totals, but no gap rate is
  // invented.
  samples.erase(1);
  result = Report(samples, 102, false);
  assert(Metric(result, "input", "total").AsString() == "100");
  assert(Metric(result, "input", "current").IsNull());
  assert(Metric(result, "input", "minimum").IsNull());
  // Partial newest snapshot leaves last complete snapshot visible.
  samples[3] = Sample(3, 900);
  samples[3].records_.erase(1);
  result = Report(samples, 106, false);
  assert(Get(result, "stale").AsBool());
  assert(Metric(result, "input", "total").AsString() == "100");
  // Duplicate identities cannot masquerade as a complete snapshot.
  auto duplicate = Sample(4, 50);
  duplicate.records_[2] = duplicate.records_[1];
  duplicate.records_[2].index_ = 2;
  assert(!duplicate.Complete());
  // A reset produces no huge unsigned rate.
  samples = {{0, Sample(0, 200)}, {1, Sample(1, 1)}};
  result = Report(samples, 101, false);
  assert(Metric(result, "input", "current").IsNull());
  // Map exhaustion makes lifetime totals lower bounds and average unknown.
  auto lost = Sample(2, 100);
  for (auto& [index, record] : lost.records_)
  {
    record.losses_ = 5;
  }
  lost.header_.losses_ = 5;
  samples[2] = lost;
  result = Report(samples, 102, false);
  assert(Get(result, "lower_bound").AsBool());
  assert(Metric(result, "input", "average").IsNull());
  // Retired identities stay in the total and TID reuse creates separate rows.
  auto retired = Sample(3, 100);
  auto record = retired.records_[1];
  record.index_ = 3;
  record.key_.thread_start_ += 1;
  record.counters_.input_ = 20;
  retired.header_.count_ = 4;
  for (auto& [index, item] : retired.records_)
  {
    item.count_ = 4;
  }
  record.count_ = 4;
  retired.Add(record, 103);
  assert(retired.Complete());
  result = Report({{3, retired}}, 103, false);
  assert(Metric(result, "input", "total").AsString() == "120");
  assert(Get(result, "rows").AsArray().size() == 3);
  // Values above JS's exact integer range survive as decimal strings.
  result = Report({{0, Sample(0, 9007199254740993ULL)}}, 100, false);
  assert(Metric(result, "input", "total").AsString() == "9007199254740993");
  // Mixed headers and reordered packets cannot create a false complete tick.
  auto mixed = Sample(0, 1);
  auto different = mixed.records_[1];
  different.process_start_ = 987;
  mixed.Add(different, 100);
  assert(!mixed.Complete());
}
}  // namespace
int main()
{
  Protocol();
  Reporting();
  std::cout << "socket protocol and reporting tests passed\n";
}
