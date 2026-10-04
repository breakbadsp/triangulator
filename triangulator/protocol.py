import dataclasses
import struct

HEADER = struct.Struct("<4sBBBBQI H2x QQII")
RECORD = struct.Struct("<IBBhIQQQQ16s")
TARGET_ABSENT = 1
STATUS_FALLBACK = 2


@dataclasses.dataclass(frozen=True)
class Record:
    tid: int
    state: str
    flags: int
    syscall: int
    futex_op: int
    utime: int
    stime: int
    run_delay: int
    timeslices: int
    comm: str

    @property
    def counters(self):
        return self.utime, self.stime, self.run_delay, self.timeslices


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
    if magic != b"TMON" or version != 1 or flags & ~3:
        raise ValueError("unsupported protocol")
    if not chunks or chunk >= chunks or count > 19 or len(data) != HEADER.size + count * RECORD.size:
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
        if not values[0] or not 32 <= values[1] < 127 or values[2] & ~1 or values[3] < -3:
            raise ValueError("invalid thread record")
        values[1] = chr(values[1])
        values[-1] = values[-1].split(b"\0", 1)[0].decode("utf-8", "replace")
        records.append(Record(*values))
    if len({record.tid for record in records}) != len(records):
        raise ValueError("duplicate thread")
    return Packet(flags, chunk, chunks, session, sequence, monotonic, wall, interval, pid, tuple(records))


def classify(record: Record, arch: str) -> str:
    futex, sockets = {
        "x86_64": (202, {0, 45, 47, 7, 271, 232, 281, 441}),
        "aarch64": (98, {63, 207, 212, 73, 22, 441}),
    }[arch]
    if record.state == "D":
        return "kernel"
    if record.state == "R" or record.syscall == -2:
        return "running"
    if record.syscall == futex:
        if record.flags & 1:
            return "idle"
        if record.futex_op & 127 == 0:
            return "lock"
        if record.futex_op & 127 == 9:
            return "condition"
    if record.syscall in sockets:
        return "socket"
    if record.syscall == -3:
        return "no_access"
    return "other"
