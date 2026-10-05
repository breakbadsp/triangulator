"""Decoder for the sampler's wire format, so the tests can read real sampler datagrams.

This mirrors the layout in common/wire.hpp; change both together."""
import dataclasses
import struct

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
