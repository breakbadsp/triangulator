"""Decoder for the sampler's wire format, so the tests can read real sampler datagrams.

This mirrors the layout in common/wire.hpp; change both together. Resource
samples (common/resource_wire.hpp) are decoded only as far as the tests need."""
import dataclasses
import re
import struct
from pathlib import Path

HEADER = struct.Struct("<4sBBBBQI H2x QQII")
RECORD = struct.Struct("<IBBHQQQQQQQ16s32s")
VERSION = 2
RECORDS_PER_PACKET = 10
TARGET_ABSENT = 1
STATUS_FALLBACK = 2
IO_UNAVAILABLE = 1


@dataclasses.dataclass(frozen=True)
class Record:
    tid: int
    state: str
    flags: int
    processor: int
    utime: int
    stime: int
    run_delay: int
    timeslices: int
    major_faults: int
    read_bytes: int
    write_bytes: int
    comm: str
    wchan: str

    @property
    def counters(self):
        return self.utime, self.stime, self.run_delay, self.timeslices, self.major_faults

    @property
    def io_counters(self):
        """Bytes read and written, or None when the sampler could not read the io file."""
        return None if self.flags & IO_UNAVAILABLE else (self.read_bytes, self.write_bytes)


@dataclasses.dataclass(frozen=True)
class Packet:
    flags: int
    chunk: int
    chunks: int
    session: int
    sequence: int
    monotonic_ns: int
    wall_ns: int
    interval_ms: int
    pid: int
    records: tuple[Record, ...]

    @property
    def signature(self):
        return (self.flags, self.chunks, self.session, self.sequence,
                self.monotonic_ns, self.wall_ns, self.interval_ms, self.pid)


def decode(data: bytes) -> Packet:
    if len(data) < HEADER.size:
        raise ValueError("short header")
    (magic, version, flags, chunk, chunks, session, sequence, count,
     monotonic, wall, interval, pid) = HEADER.unpack_from(data)
    if magic != b"TMON" or version != VERSION or flags & ~3:
        raise ValueError("unsupported protocol")
    if not chunks or chunk >= chunks or count > RECORDS_PER_PACKET or len(data) != HEADER.size + count * RECORD.size:
        raise ValueError("invalid packet length or chunk")
    if not 100 <= interval <= 5000 or not monotonic or not wall:
        raise ValueError("invalid sample clock")
    if flags & TARGET_ABSENT and (count or pid or chunks != 1):
        raise ValueError("invalid absent heartbeat")
    if not flags & TARGET_ABSENT and not pid:
        raise ValueError("missing target pid")
    records = []
    for offset in range(HEADER.size, len(data), RECORD.size):
        values = list(RECORD.unpack_from(data, offset))
        if not values[0] or not 32 <= values[1] < 127 or values[2] & ~IO_UNAVAILABLE:
            raise ValueError("invalid thread record")
        values[1] = chr(values[1])
        values[-2], values[-1] = (value.split(b"\0", 1)[0].decode("utf-8", "replace") for value in values[-2:])
        records.append(Record(*values))
    if len({record.tid for record in records}) != len(records):
        raise ValueError("duplicate thread")
    return Packet(flags, chunk, chunks, session, sequence, monotonic, wall, interval, pid, tuple(records))


# Kernel wait-channel names (/proc/<tid>/wchan) mapped to coarse states. Names
# vary across kernel versions, so matching is by substring; unknown names show
# as "other" with the raw wchan alongside.
WCHAN_STATES = (
    ("futex", "futex"),
    ("epoll", "poll"), ("poll", "poll"), ("select", "poll"),
    ("skb", "socket"), ("sk_wait", "socket"), ("sock", "socket"), ("unix_stream", "socket"),
    ("inet_csk", "socket"), ("tcp_", "socket"), ("udp_", "socket"),
    ("pipe", "pipe"), ("eventfd", "pipe"),
    ("nanosleep", "sleep"),
)


def classify(record: Record) -> str:
    if record.state == "D":
        return "kernel"
    if record.state == "R":
        return "running"
    if record.state in "tT":
        return "stopped"
    if not record.wchan:
        return "no_access"
    for needle, state in WCHAN_STATES:
        if needle in record.wchan:
            return state
    return "other"


RESOURCE_HEADER = struct.Struct("<4sBBBBQIH2xQQIIQI4x")
RESOURCE_SUMMARY = 1
RESOURCE_SOCKETS = 2
UNAVAILABLE = 2**64 - 1


def _summary_fields():
    """The summary field names, read from the C++ header so there is one list."""
    source = (Path(__file__).resolve().parents[1] / "common/resource_wire.hpp").read_text()
    source = re.sub(r"//[^\n]*", "", source)
    block = re.search(r"kSummaryFields\{(.*?)\};", source, re.S).group(1)
    return tuple(re.findall(r'"([a-z0-9_]+)"', block))


SUMMARY_FIELDS = _summary_fields()


@dataclasses.dataclass(frozen=True)
class ResourcePart:
    kind: int
    part: int
    parts: int
    session: int
    sequence: int
    count: int
    monotonic_ns: int
    wall_ns: int
    interval_ms: int
    pid: int
    process_start: int
    flags: int
    values: dict
    cgroup: str


def decode_resource(data: bytes) -> ResourcePart:
    """Header and summary values (None when unavailable) of a resource datagram."""
    (magic, version, kind, part, parts, session, sequence, count, monotonic, wall,
     interval, pid, process_start, flags) = RESOURCE_HEADER.unpack_from(data)
    if magic != b"TRES" or version != 1:
        raise ValueError("not a resource datagram")
    values, cgroup = {}, ""
    if kind == RESOURCE_SUMMARY:
        numbers = struct.unpack_from(f"<{len(SUMMARY_FIELDS)}Q", data, RESOURCE_HEADER.size)
        values = {name: None if value == UNAVAILABLE else value for name, value in zip(SUMMARY_FIELDS, numbers)}
        offset = RESOURCE_HEADER.size + 8 * len(SUMMARY_FIELDS)
        cgroup = data[offset:offset + 128].split(b"\0", 1)[0].decode()
    return ResourcePart(kind, part, parts, session, sequence, count, monotonic, wall, interval, pid,
                        process_start, flags, values, cgroup)


def receive_tick(receiver, size=1500):
    """The next thread-tick datagram, skipping the sampler's resource samples."""
    while True:
        data = receiver.recv(size)
        if not data.startswith(b"TRES"):
            return data
