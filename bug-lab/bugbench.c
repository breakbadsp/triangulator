// bugbench: a deliberately buggy program for validating Triangulator.
//
// Each scenario reproduces one real-world resource bug (CPU, memory, I/O,
// descriptors, sockets, threads). Run one scenario at a time and check whether
// the Triangulator dashboard shows the problem.
//
//   bugbench <scenario> [seconds]      (default 90 seconds, then exits cleanly)
//   bugbench --list
//
// The process name (comm) is "bb-<scenario>" so that the sampler can select it
// with `scripts/set-target.sh bb-<scenario>`. Worker threads use the thread
// prefixes from config/collector.toml (worker-, io-, sender-, misc-).
//
// THIS CODE IS BUGGY ON PURPOSE. It leaks, spins, deadlocks and ignores errors.
// Do not copy it, and do not run it on a machine you care about for longer than
// the scenario's duration. It is a test fixture, not product code.

#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t g_stop;
static double g_deadline;
static double g_start;

static double now_s(void)
{
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static int running(void) { return !g_stop && now_s() < g_deadline; }

static void sleep_ms(long ms)
{
  struct timespec ts = {ms / 1000, (ms % 1000) * 1000000L};
  nanosleep(&ts, NULL);
}

static void say(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
static void say(const char* fmt, ...)
{
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "[bugbench %6.1fs] ", now_s() - g_start);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  va_end(ap);
}

struct start_info
{
  void* (*fn)(void*);
  char name[16];
  intptr_t arg;
};

static void* thread_main(void* p)
{
  struct start_info info = *(struct start_info*)p;
  free(p);
  prctl(PR_SET_NAME, info.name, 0, 0, 0);
  return info.fn((void*)info.arg);
}

static void start_thread(void* (*fn)(void*), intptr_t arg, const char* fmt, int index)
{
  struct start_info* info = calloc(1, sizeof *info);
  info->fn = fn;
  info->arg = arg;
  snprintf(info->name, sizeof info->name, fmt, index);
  pthread_t t;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  pthread_attr_setstacksize(&attr, 256 * 1024);
  if (pthread_create(&t, &attr, thread_main, info) != 0)
  {
    free(info);
  }
}

static const char* lab_dir(void)
{
  const char* d = getenv("BUG_LAB_DIR");
  return d ? d : "/var/tmp/bug-lab";
}

// ---------------------------------------------------------------- CPU

// BUG: a hot loop with no sleep or backoff. One thread pegs a core at 100%.
static void* spin_forever(void* arg)
{
  (void)arg;
  volatile uint64_t x = 1;
  while (running())
  {
    x = x * 6364136223846793005ULL + 1442695040888963407ULL;
  }
  return NULL;
}

static void* idle_worker(void* arg)
{
  (void)arg;
  while (running())
  {
    sleep_ms(1000);
  }
  return NULL;
}

static void cpu_spin(void)
{
  start_thread(spin_forever, 0, "worker-hot", 0);
  for (int i = 0; i < 3; ++i)
  {
    start_thread(idle_worker, 0, "worker-idle%d", i);
  }
}

// BUG: three times more runnable threads than cores (a pool sized "to be safe").
// The threads fight for the CPUs, so each one waits in the run queue.
static void cpu_oversub(void)
{
  nice(15);  // keep the desktop usable while this runs
  long cores = sysconf(_SC_NPROCESSORS_ONLN);
  for (long i = 0; i < cores * 3; ++i)
  {
    start_thread(spin_forever, 0, "worker-%d", (int)i);
  }
}

// BUG: the same busy threads, but the runner puts them in a cgroup with a 50%
// CPU quota. The scheduler throttles them: low CPU use, large CPU pressure.
static void cpu_throttle(void)
{
  for (int i = 0; i < 4; ++i)
  {
    start_thread(spin_forever, 0, "worker-%d", i);
  }
}

// BUG: sched_yield() in a loop used as "polling". Almost no useful work, a
// flood of context switches and system time.
static void* yield_loop(void* arg)
{
  (void)arg;
  while (running())
  {
    sched_yield();
  }
  return NULL;
}

static void yield_storm(void)
{
  nice(10);
  for (int i = 0; i < 4; ++i)
  {
    start_thread(yield_loop, 0, "worker-%d", i);
  }
}

// ---------------------------------------------------------------- locks

static pthread_mutex_t g_big_lock = PTHREAD_MUTEX_INITIALIZER;

// BUG: sleeps (pretends to do I/O) while holding one global lock. Eight threads
// queue behind it: CPU stays near zero while throughput collapses.
static void* convoy_worker(void* arg)
{
  (void)arg;
  while (running())
  {
    pthread_mutex_lock(&g_big_lock);
    sleep_ms(20);
    pthread_mutex_unlock(&g_big_lock);
    volatile uint64_t x = 0;
    (void)x;
    for (int i = 0; i < 200000; ++i)
    {
      x += (uint64_t)i;
    }
  }
  return NULL;
}

static void lock_convoy(void)
{
  for (int i = 0; i < 8; ++i)
  {
    start_thread(convoy_worker, 0, "worker-%d", i);
  }
}

static pthread_mutex_t g_lock_a = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t g_lock_b = PTHREAD_MUTEX_INITIALIZER;

// BUG: two threads take two locks in opposite order (classic ABBA deadlock).
// After a fraction of a second both wait forever. The process still looks alive
// because a heartbeat thread keeps running.
static void* abba_first(void* arg)
{
  (void)arg;
  pthread_mutex_lock(&g_lock_a);
  sleep_ms(300);
  pthread_mutex_lock(&g_lock_b);
  pthread_mutex_unlock(&g_lock_b);
  pthread_mutex_unlock(&g_lock_a);
  return NULL;
}

static void* abba_second(void* arg)
{
  (void)arg;
  pthread_mutex_lock(&g_lock_b);
  sleep_ms(300);
  pthread_mutex_lock(&g_lock_a);
  pthread_mutex_unlock(&g_lock_a);
  pthread_mutex_unlock(&g_lock_b);
  return NULL;
}

static void* heartbeat(void* arg)
{
  (void)arg;
  while (running())
  {
    sleep_ms(500);
    volatile uint64_t x = 0;
    (void)x;
    for (int i = 0; i < 100000; ++i)
    {
      x += (uint64_t)i;
    }
  }
  return NULL;
}

static void deadlock(void)
{
  start_thread(heartbeat, 0, "misc-heartbeat", 0);
  sleep_ms(2000);  // a healthy start, then the bug strikes
  start_thread(abba_first, 0, "worker-a", 0);
  start_thread(abba_second, 0, "worker-b", 0);
}

// ---------------------------------------------------------------- memory

static size_t g_leaked;

// BUG: allocates and touches memory every 100 ms and never frees it. 8 MB/s
// until g_leak_cap, in 64 KB chunks that come from the heap.
static size_t g_leak_cap = (size_t)1200 << 20;

static void* leak_worker(void* arg)
{
  (void)arg;
  while (running())
  {
    for (int i = 0; i < 12 && g_leaked < g_leak_cap; ++i)
    {
      char* p = malloc(64 * 1024);
      if (p != NULL)
      {
        memset(p, 0xA5, 64 * 1024);
        g_leaked += 64 * 1024;
      }
    }
    sleep_ms(100);
  }
  return NULL;
}

static void mem_leak(void)
{
  start_thread(leak_worker, 0, "worker-leak", 0);
  start_thread(heartbeat, 0, "worker-ok", 0);
}

static void mem_oom(void)
{
  g_leak_cap = (size_t)4 << 30;  // never reaches it: the cgroup limit hits first
  mem_leak();
}

// BUG: reserves a huge address range, then splits another range into thousands
// of one-page mappings with alternating protections (so they cannot merge).
// RLIMIT_AS is set low, like a container with a virtual-memory ulimit.
static void* vm_worker(void* arg)
{
  (void)arg;
  size_t page = (size_t)sysconf(_SC_PAGESIZE);
  struct rlimit rl = {(rlim_t)3 << 30, (rlim_t)3 << 30};
  setrlimit(RLIMIT_AS, &rl);
  for (int i = 0; i < 22; ++i)
  {
    void* p = mmap(NULL, (size_t)100 << 20, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
    if (p == MAP_FAILED)
    {
      say("reserve %d failed: %s", i, strerror(errno));
      break;
    }
  }
  size_t count = 100000;
  char* base = mmap(NULL, count * page, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (base == MAP_FAILED)
  {
    say("fragment arena failed: %s", strerror(errno));
    return NULL;
  }
  for (size_t i = 0; i < count && running(); i += 2)
  {
    mprotect(base + i * page, page, PROT_READ | PROT_WRITE);
    if ((i & 0x3ff) == 0)
    {
      base[i * page] = 1;  // touch a few so RSS is not zero
    }
    if ((i & 0x1fff) == 0)
    {
      sleep_ms(50);
    }
  }
  say("created about %zu mappings", count / 2);
  while (running())
  {
    // Later requests for address space fail with ENOMEM.
    void* p = mmap(NULL, (size_t)64 << 20, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (p == MAP_FAILED)
    {
      say("allocation failed: %s (ignored)", strerror(errno));
    }
    sleep_ms(2000);
  }
  return NULL;
}

static void vm_bloat(void) { start_thread(vm_worker, 0, "worker-vm", 0); }

// ---------------------------------------------------------------- descriptors

// BUG: opens a file for every request and forgets to close it. The soft limit
// is lowered so the leak reaches EMFILE within about a minute.
static void* fd_leak_worker(void* arg)
{
  (void)arg;
  while (running())
  {
    int fd = open("/dev/null", O_RDONLY);
    if (fd < 0)
    {
      say("open failed: %s (retrying forever)", strerror(errno));
    }
    sleep_ms(250);
  }
  return NULL;
}

static void fd_leak(void)
{
  struct rlimit rl;
  getrlimit(RLIMIT_NOFILE, &rl);
  rl.rlim_cur = 300;
  setrlimit(RLIMIT_NOFILE, &rl);
  start_thread(fd_leak_worker, 0, "worker-leak", 0);
  start_thread(heartbeat, 0, "worker-ok", 0);
}

// ---------------------------------------------------------------- storage

// BUG: calls fsync() after every 256 KB write from four threads, on a
// copy-on-write filesystem. Threads sit in uninterruptible I/O wait.
static void* sync_writer(void* arg)
{
  int id = (int)(intptr_t)arg;
  char path[256];
  snprintf(path, sizeof path, "%s/sync-%d.dat", lab_dir(), id);
  int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0600);
  if (fd < 0)
  {
    say("open %s: %s", path, strerror(errno));
    return NULL;
  }
  static char block[256 * 1024];
  memset(block, 0x5A, sizeof block);
  off_t off = 0;
  while (running())
  {
    pwrite(fd, block, sizeof block, off);
    off = (off + (off_t)sizeof block) % ((off_t)64 << 20);  // overwrite in place: cow churn
    fsync(fd);
  }
  close(fd);
  unlink(path);
  return NULL;
}

static void disk_sync(void)
{
  mkdir(lab_dir(), 0700);
  for (int i = 0; i < 4; ++i)
  {
    start_thread(sync_writer, i, "io-writer%d", i);
  }
  start_thread(heartbeat, 0, "worker-ok", 0);
}

// BUG: reads a file through mmap in random order while the kernel keeps
// dropping it from the page cache (MADV_PAGEOUT stands in for memory pressure),
// so most touches are major page faults that wait for the disk.
static void* fault_reader(void* arg)
{
  int id = (int)(intptr_t)arg;
  size_t size = (size_t)512 << 20;
  char path[256];
  snprintf(path, sizeof path, "%s/fault.dat", lab_dir());
  int fd = open(path, O_RDONLY);
  if (fd < 0)
  {
    say("open %s: %s", path, strerror(errno));
    return NULL;
  }
  unsigned seed = (unsigned)id * 7919u + 1;
  while (running())
  {
    if (id == 0)
    {
      posix_fadvise(fd, 0, (off_t)size, POSIX_FADV_DONTNEED);
    }
    char* map = mmap(NULL, size, PROT_READ, MAP_SHARED, fd, 0);
    if (map == MAP_FAILED)
    {
      return NULL;
    }
    madvise(map, size, MADV_RANDOM);
    volatile char sink = 0;
    (void)sink;
    double until = now_s() + 4.0;
    unsigned touched = 0;
    while (running() && now_s() < until)
    {
      size_t page = (size_t)rand_r(&seed) % (size / 4096);
      sink ^= map[page * 4096];
      if ((++touched & 0x3ff) == 0)
      {
        // Evict the cached pages again so the next touches are major faults.
        madvise(map, size, MADV_PAGEOUT);
      }
    }
    munmap(map, size);
  }
  close(fd);
  return NULL;
}

static void major_faults(void)
{
  mkdir(lab_dir(), 0700);
  char path[256];
  snprintf(path, sizeof path, "%s/fault.dat", lab_dir());
  int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0600);
  static char block[1 << 20];
  memset(block, 0x33, sizeof block);
  for (int i = 0; i < 512; ++i)
  {
    pwrite(fd, block, sizeof block, (off_t)i << 20);
  }
  fsync(fd);
  close(fd);
  for (int i = 0; i < 2; ++i)
  {
    start_thread(fault_reader, i, "io-reader%d", i);
  }
  start_thread(heartbeat, 0, "worker-ok", 0);
}

// ---------------------------------------------------------------- sockets

static int listen_on(int backlog, int rcvbuf, struct sockaddr_in* addr)
{
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (rcvbuf > 0)
  {
    setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof rcvbuf);
  }
  memset(addr, 0, sizeof *addr);
  addr->sin_family = AF_INET;
  addr->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  bind(fd, (struct sockaddr*)addr, sizeof *addr);
  listen(fd, backlog);
  socklen_t len = sizeof *addr;
  getsockname(fd, (struct sockaddr*)addr, &len);
  return fd;
}

static struct sockaddr_in g_addr;

// BUG: the consumer reads 4 KB, then sleeps 200 ms ("rate limiting").
static void* slow_reader(void* arg)
{
  int lfd = (int)(intptr_t)arg;
  int fd = accept(lfd, NULL, NULL);
  char buf[4096];
  while (running())
  {
    if (read(fd, buf, sizeof buf) <= 0)
    {
      break;
    }
    sleep_ms(200);
  }
  return NULL;
}

// The producer writes as fast as it can and blocks when the kernel buffer is full.
static void* fast_sender(void* arg)
{
  (void)arg;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  int sndbuf = 64 * 1024;
  setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof sndbuf);
  if (connect(fd, (struct sockaddr*)&g_addr, sizeof g_addr) != 0)
  {
    return NULL;
  }
  static char block[64 * 1024];
  while (running())
  {
    if (write(fd, block, sizeof block) < 0)
    {
      break;
    }
  }
  return NULL;
}

static void tcp_slow(void)
{
  int lfd = listen_on(16, 64 * 1024, &g_addr);
  start_thread(slow_reader, lfd, "worker-reader", 0);
  start_thread(fast_sender, 0, "sender-%d", 1);
}

// BUG: UDP receiver with a tiny socket buffer that handles one datagram per
// 50 ms while a sender sends thousands per second. The kernel drops the rest
// and nobody notices.
static int g_udp_fd;

static void* udp_receiver(void* arg)
{
  (void)arg;
  char buf[2048];
  while (running())
  {
    recv(g_udp_fd, buf, sizeof buf, 0);
    sleep_ms(50);
  }
  return NULL;
}

static void* udp_sender(void* arg)
{
  (void)arg;
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  char buf[1024];
  memset(buf, 'u', sizeof buf);
  while (running())
  {
    sendto(fd, buf, sizeof buf, 0, (struct sockaddr*)&g_addr, sizeof g_addr);
    usleep(200);
  }
  return NULL;
}

static void udp_drop(void)
{
  g_udp_fd = socket(AF_INET, SOCK_DGRAM, 0);
  int rcvbuf = 4096;
  setsockopt(g_udp_fd, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof rcvbuf);
  memset(&g_addr, 0, sizeof g_addr);
  g_addr.sin_family = AF_INET;
  g_addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  bind(g_udp_fd, (struct sockaddr*)&g_addr, sizeof g_addr);
  socklen_t len = sizeof g_addr;
  getsockname(g_udp_fd, (struct sockaddr*)&g_addr, &len);
  start_thread(udp_receiver, 0, "worker-recv", 0);
  start_thread(udp_sender, 0, "sender-%d", 1);
}

// BUG: the server keeps every accepted socket and never closes it, even after
// the client has hung up. The sockets sit in CLOSE-WAIT and the descriptor
// count climbs towards RLIMIT_NOFILE.
static void* leaky_acceptor(void* arg)
{
  int lfd = (int)(intptr_t)arg;
  while (running())
  {
    int fd = accept(lfd, NULL, NULL);
    if (fd < 0)
    {
      say("accept failed: %s (ignored)", strerror(errno));
      sleep_ms(500);
    }
  }
  return NULL;
}

static void* short_client(void* arg)
{
  (void)arg;
  while (running())
  {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (connect(fd, (struct sockaddr*)&g_addr, sizeof g_addr) == 0)
    {
      write(fd, "hello", 5);
    }
    close(fd);
    sleep_ms(80);
  }
  return NULL;
}

static void close_wait(void)
{
  int lfd = listen_on(128, 0, &g_addr);
  start_thread(leaky_acceptor, lfd, "worker-accept", 0);
  start_thread(short_client, 0, "sender-%d", 1);
  start_thread(heartbeat, 0, "worker-ok", 0);
}

// BUG: listen backlog of 1 and the accept loop is busy elsewhere. Connection
// attempts overflow the accept queue; clients see long connect stalls.
static void* connect_attempts(void* arg)
{
  (void)arg;
  while (running())
  {
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0);
    connect(fd, (struct sockaddr*)&g_addr, sizeof g_addr);
    struct pollfd p = {fd, POLLOUT, 0};
    poll(&p, 1, 1500);
    close(fd);
  }
  return NULL;
}

static void listen_full(void)
{
  int lfd = listen_on(1, 0, &g_addr);
  (void)lfd;  // BUG: never accept()ed
  for (int i = 0; i < 4; ++i)
  {
    start_thread(connect_attempts, 0, "sender-%d", i);
  }
  start_thread(heartbeat, 0, "worker-ok", 0);
}

// ---------------------------------------------------------------- threads

static void* short_task(void* arg)
{
  (void)arg;
  volatile uint64_t x = 0;
    (void)x;
  for (int i = 0; i < 20000; ++i)
  {
    x += (uint64_t)i;
  }
  return NULL;
}

// BUG: starts a new thread per task instead of using a pool, about 150 per second.
static void* churn_spawner(void* arg)
{
  (void)arg;
  while (running())
  {
    pthread_t t[15];
    int n = 0;
    for (; n < 15; ++n)
    {
      if (pthread_create(&t[n], NULL, short_task, NULL) != 0)
      {
        break;
      }
    }
    for (int i = 0; i < n; ++i)
    {
      pthread_join(t[i], NULL);
    }
    sleep_ms(100);
  }
  return NULL;
}

static void thread_churn(void)
{
  start_thread(churn_spawner, 0, "misc-spawner", 0);
  start_thread(heartbeat, 0, "worker-ok", 0);
}

static pthread_mutex_t g_park_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_park_cond = PTHREAD_COND_INITIALIZER;

// BUG: every "request" starts a thread that waits for a reply that never
// comes. Threads (and their stacks) pile up.
static void* parked_thread(void* arg)
{
  (void)arg;
  pthread_mutex_lock(&g_park_lock);
  while (running())
  {
    pthread_cond_wait(&g_park_cond, &g_park_lock);
  }
  pthread_mutex_unlock(&g_park_lock);
  return NULL;
}

static void* leak_spawner(void* arg)
{
  (void)arg;
  for (int i = 0; i < 600 && running(); ++i)
  {
    start_thread(parked_thread, 0, "worker-park", 0);
    sleep_ms(100);
  }
  return NULL;
}

static void thread_leak(void)
{
  start_thread(leak_spawner, 0, "misc-spawner", 0);
  start_thread(heartbeat, 0, "worker-ok", 0);
}

// ---------------------------------------------------------------- control

// The control case: a service that does a little work and waits. Nothing here
// should raise a finding. The runner also uses it to test a stopped process.
static void healthy(void)
{
  for (int i = 0; i < 4; ++i)
  {
    start_thread(heartbeat, 0, "worker-%d", i);
  }
}

struct scenario
{
  const char* name;
  void (*run)(void);
  const char* bug;
};

static const struct scenario kScenarios[] = {
    {"healthy", healthy, "control: light periodic work, no bug"},
    {"cpu-spin", cpu_spin, "one thread in a hot loop"},
    {"cpu-oversub", cpu_oversub, "3x more runnable threads than cores"},
    {"cpu-throttle", cpu_throttle, "busy threads under a 50% cgroup CPU quota"},
    {"yield-storm", yield_storm, "sched_yield() polling loops"},
    {"lock-convoy", lock_convoy, "sleeping while holding one global lock"},
    {"deadlock", deadlock, "ABBA lock-order deadlock, process looks alive"},
    {"mem-leak", mem_leak, "heap grows 8 MB/s, never freed"},
    {"mem-oom", mem_oom, "same leak inside a small cgroup memory limit"},
    {"vm-bloat", vm_bloat, "huge address reservation and 50,000 tiny mappings"},
    {"fd-leak", fd_leak, "open() without close() until EMFILE"},
    {"disk-sync", disk_sync, "fsync after every write from four threads"},
    {"major-faults", major_faults, "random mmap reads of an uncached file"},
    {"tcp-slow", tcp_slow, "slow consumer, fast producer over TCP"},
    {"udp-drop", udp_drop, "UDP flood into a tiny receive buffer"},
    {"close-wait", close_wait, "server never closes accepted sockets"},
    {"listen-full", listen_full, "listen backlog 1, nobody calls accept()"},
    {"thread-churn", thread_churn, "one new thread per task, 150 per second"},
    {"thread-leak", thread_leak, "threads that wait forever pile up"},
};

static void on_signal(int sig) { (void)sig; g_stop = 1; }

int main(int argc, char** argv)
{
  if (argc >= 2 && strcmp(argv[1], "--list") == 0)
  {
    for (size_t i = 0; i < sizeof kScenarios / sizeof *kScenarios; ++i)
    {
      printf("%-14s %s\n", kScenarios[i].name, kScenarios[i].bug);
    }
    return 0;
  }
  if (argc < 2)
  {
    fprintf(stderr, "usage: bugbench <scenario> [seconds] | --list\n");
    return 2;
  }
  const struct scenario* chosen = NULL;
  for (size_t i = 0; i < sizeof kScenarios / sizeof *kScenarios; ++i)
  {
    if (strcmp(kScenarios[i].name, argv[1]) == 0)
    {
      chosen = &kScenarios[i];
    }
  }
  if (chosen == NULL)
  {
    fprintf(stderr, "unknown scenario %s (try --list)\n", argv[1]);
    return 2;
  }
  double seconds = argc >= 3 ? atof(argv[2]) : 90.0;
  g_start = now_s();
  g_deadline = g_start + seconds;

  char comm[16];
  snprintf(comm, sizeof comm, "bb-%.12s", chosen->name);
  prctl(PR_SET_NAME, comm, 0, 0, 0);
  signal(SIGTERM, on_signal);
  signal(SIGINT, on_signal);
  signal(SIGPIPE, SIG_IGN);

  say("%s: %s (pid %d, %.0f s)", chosen->name, chosen->bug, getpid(), seconds);
  chosen->run();
  while (running())
  {
    sleep_ms(200);
  }
  say("done");
  return 0;
}
