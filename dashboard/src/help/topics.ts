export interface HelpTopic {
  title: string;
  meaning?: string;
  source: string;
  sourceDetail: string;
}

const topics = {
  page: {
    title: "How to read this page",
    source: "`/proc` and `/sys/fs/cgroup` → sampler → collector → this page",
    sourceDetail:
      "The sampler runs on the target host as the target user. It reads `/proc` and `/sys/fs/cgroup` files and sends the raw counters over UDP. The collector turns counters into rates, stores history, and serves this page through `/api/…` endpoints. This page computes load, assessments, and findings. The Source section of each topic names its file.",
  },
  "target-attention": {
    title: "Other targets need attention",
    source: "Collector target status and sampler rate",
    sourceDetail:
      "The page counts absent, silent, and throttled entries from `/api/targets`, excluding the selected target.",
  },
  "target-access": {
    title: "Limited access",
    source: "Sampler access checks for `/proc/PID/io` and `/proc/PID/maps`",
    sourceDetail:
      "The sampler reports limited access when these files cannot be opened. Permission changes are checked with each announcement.",
  },
  "sampler-budget": {
    title: "Sampler throttled",
    source: "`CLOCK_THREAD_CPUTIME_ID` and monotonic elapsed time",
    sourceDetail:
      "The sampler measures CPU time for all targets and sends raw counters in TTGT. The collector computes the percentage. The sampler lowers the rate after about five seconds above its budget.",
  },
  assesshistory: {
    title: "Past assessments",
    source: "Recordings from `/api/replay`, checked in this page",
    sourceDetail:
      "This page loads recorded views from the collector through `/api/replay` and applies the Assessment rules to each one.",
  },
  historyfilters: {
    title: "Past assessment filters",
    source: "Past assessments already checked in this page",
    sourceDetail: "Filters hide rows and marks. They send no request.",
  },
  timeline: {
    title: "Timeline and recorded views",
    source: "Collector /api/replay snapshots and /api/resources rollups",
    sourceDetail:
      "recorded_at fixes the display clock. Snapshot rates cover the preceding sampling interval. Resource reads end at that time. Recordings never enter this tab's live trends or storage.",
  },
  exited: {
    title: "Final process view",
    source: "Sampler absence and collector /api/last-target, /api/live",
    sourceDetail:
      "This tab saves the final view, compatible memory layout, and matching exit in target-scoped session storage. Later resource reads end at the stopped time; layout refresh stops.",
  },
  "fleet-waiting": {
    title: "Waiting for a process",
    source: "Sampler discovery and absent heartbeat",
    sourceDetail: "A waiting slot sends an absent heartbeat with PID zero.",
  },
  "fleet-capacity": {
    title: "Target capacity",
    source: "TTGT excluded count and collector capacity_drops",
    sourceDetail:
      "Both programs preallocate target slots. The sampler reports excluded matches after each completed bounded pass.",
  },
  "manage-targets": {
    title: "Manage targets",
    source: "Local control helper, kernel packet source, and sampler.toml",
    sourceDetail:
      "The helper verifies the runtime sampler executable, user, and loopback collector endpoint. The API checks the selected target's kernel source address. Host names do not grant access. The sampler validates a full file before reload.",
  },
  "target-id": {
    title: "Target ID",
    source: "Sampler discovery: the sanitized `/proc/PID/comm` name",
    sourceDetail:
      "The sampler sends this ID in TTGT. A target key combines the sampler host name and this ID.",
  },
  "fleet-filter": {
    title: "Find targets",
    meaning:
      "Search shows the tiles whose process name, host, or target ID contains the text. Search includes every assessment level.",
    source: "",
    sourceDetail: "",
  },
  "fleet-tile": {
    title: "Target tile",
    source:
      "Collector: `/api/targets` and `/api/live?target=host/id`; assessment computed in this page",
    sourceDetail:
      "The name and status come from the target list and latest live view. Findings use the same rules as the Assessment card. The process dashboard shows the measurements and monitoring details.",
  },

  target: {
    title: "Process name",
    source:
      "Sampler `process_names` and `process_patterns`; names match `/proc/PID/comm`",
    sourceDetail:
      "Manage targets writes the configuration and asks the sampler to reload. For a name, the sampler compares it with `/proc/PID/comm` of every process. Check it yourself: `pgrep -x NAME`.",
  },
  "target-switch": {
    title: "Monitoring target",
    source: "Collector: `/api/targets`; URL `?target=host/id`",
    sourceDetail:
      "TTGT announcements identify each host and target ID. The collector routes sessions and returns target metadata. This tab adds the selected key to its API requests.",
  },
  appearance: {
    title: "Color theme",
    meaning: "Select System, Light, or Dark for the dashboard.",
    source: "",
    sourceDetail: "",
  },
  "section-navigation": {
    title: "Section navigation",
    meaning:
      "The highlighted tab identifies the section at the top of the visible page.",
    source: "",
    sourceDetail: "",
  },
  health: {
    title: "Monitor health",
    source: "Collector: datagrams received from the sampler",
    sourceDetail:
      "The collector counts the UDP datagrams it receives from the sampler: when the last one arrived, their session, sequence gaps, and rejected packets. It serves the result in `/api/live`. Nothing here is read from the target process.",
  },
  interval: {
    title: "Sample interval",
    source: "`rate_hz` in sampler.toml",
    sourceDetail:
      "The sampler sends its interval in every datagram. It comes from `rate_hz` in sampler.toml, which `scripts/set-rate.sh` changes (0.2–10 Hz, 5 Hz by default).",
  },
  loss: {
    title: "Packet loss (1 min)",
    source: "Collector: gaps in the numbered sampler datagrams",
    sourceDetail:
      "The sampler numbers each sample and the datagrams it is split into. Over the last minute, the collector counts the datagrams that never arrived, including whole skipped samples, and divides by the number expected.",
  },
  session: {
    title: "Session",
    source: "Random ID chosen by the sampler",
    sourceDetail:
      "The sampler picks a random session ID when it starts, reloads its configuration, or finds a new target process, and puts it in every datagram. The collector stores history under that ID.",
  },
  packetcounts: {
    title: "Bad · duplicate · late",
    source: "Collector packet counters",
    sourceDetail:
      "The collector counts datagrams it could not decode (bad), received twice (duplicate), or that arrived after their sample was assembled (late).",
  },
  rawsamples: {
    title: "Raw samples held",
    source: "Collector memory",
    sourceDetail:
      "The number of raw thread samples in the in-memory buffer of the collector, from `/api/live`.",
  },
  fleet: {
    title: "Targets overview",
    source: "Collector: `/api/fleet`",
    sourceDetail:
      "The page makes one `/api/fleet` request every 5 seconds. It returns the target list and the latest live view of each target from one publication. Tile order is stored in this browser under `triangulator:fleet-order`.",
  },
  overview: {
    title: "Process overview",
    source: "Thread samples from `/proc/PID/task/TID/`, summed",
    sourceDetail:
      "The tiles sum the values of the threads: CPU and faults from `stat`, run delay and switches from `schedstat`, read and write bytes from `io`, and states from `stat` and `wchan`.",
  },
  assessment: {
    title: "Assessment",
    source: "Computed in this page from the displayed data",
    sourceDetail:
      "This page applies fixed rules to the values it shows: thread samples, resource samples, memory samples, and monitor health. Each finding names the value it used; the topic of that value gives its source.",
  },
  verdict: {
    title: "Assessment verdict",
    source: "Computed in this page from the displayed data",
    sourceDetail:
      "The same rules as the Assessment card. Each finding names the value it used.",
  },
  active: {
    title: "Active threads",
    source: "Thread counters in `/proc/PID/task/TID/`",
    sourceDetail:
      "A thread is active when, in the preceding ~10 seconds, it used CPU (`stat` utime + stime), was put on a CPU (`schedstat`), read or wrote (`io` rchar, wchar), had a major fault (`stat` majflt), or was sampled running, in kernel wait, or stopped. The collector computes the rates; this page applies the rule.",
  },
  switches: {
    title: "Context switches",
    source: "`/proc/PID/task/TID/schedstat`: third number",
    sourceDetail:
      "The third number in `/proc/PID/task/TID/schedstat` counts how many times the scheduler put the thread on a CPU. The collector divides its change by the time between samples. With `status_fallback = true`, the sampler reads voluntary_ctxt_switches from `/proc/PID/task/TID/status` instead. Check it yourself: `cat /proc/PID/task/TID/schedstat`.",
  },
  sysio: {
    title: "Disk & syscall I/O",
    source: "`/proc/PID/task/TID/io`: rchar, wchar",
    sourceDetail:
      "Each sample, the sampler reads the rchar and wchar lines of `/proc/PID/task/TID/io`: bytes passed to read- and write-family system calls, including sockets, pipes, and cached files. The collector divides the change by the time between samples. Process values sum the threads. The file is readable only when the sampler runs as the target user. Check it yourself: `cat /proc/PID/task/TID/io`.",
  },
  faults: {
    title: "Major faults",
    source: "`/proc/PID/task/TID/stat`: field 12 (majflt)",
    sourceDetail:
      "Each sample, the sampler reads field 12 of `/proc/PID/task/TID/stat`, the count of major page faults of the thread. The collector divides its change by the time between samples. Process values sum the threads.",
  },
  churn: {
    title: "Thread churn",
    source: "Thread IDs in `/proc/PID/task`, compared between updates",
    sourceDetail:
      "Each sample, the sampler lists `/proc/PID/task`, which has one entry per live thread. This page compares the thread IDs of consecutive live updates: a new ID counts as a start and a missing ID as an end. The kernel keeps no count of created threads that an unprivileged reader can see.",
  },
  load: {
    title: "Process load",
    source:
      "Computed in this page from thread CPU, run delay, and kernel waits",
    sourceDetail:
      "This page computes it from each live update: the CPU use and run delay of all threads (from `stat` and `schedstat`), plus the number of threads in uninterruptible kernel wait (state D in `stat`). It applies the same exponential averaging that the kernel uses for `/proc/loadavg`, but only to this process.",
  },
  cpucores: {
    title: "On CPU now",
    source: "`/proc/PID/task/TID/stat`: utime + stime, summed",
    sourceDetail:
      "The sum of thread CPU (see CPU) divided by 100: CPU seconds per elapsed second.",
  },
  demand: {
    title: "Waiting for CPU",
    source: "`stat` CPU and `schedstat` run delay, summed",
    sourceDetail:
      "Summed over all threads: run delay (the second number of `/proc/PID/task/TID/schedstat`) divided by CPU time (utime + stime of `stat`) plus run delay.",
  },
  thread: {
    title: "Thread / TID",
    source: "`/proc/PID/task` and `stat` field 2 (comm)",
    sourceDetail:
      "The thread IDs are the entries of `/proc/PID/task`. The name is field 2 of `/proc/PID/task/TID/stat`, the same as `/proc/PID/task/TID/comm`, which the kernel cuts to 15 bytes. The collector adds a generation number when a TID is reused. Check it yourself: `ls /proc/PID/task`.",
  },
  kernel: {
    title: "Kernel wait (D)",
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Kernel wait (D) when field 3 of `stat` is D. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  "memory-use": {
    title: "Memory use",
    source: "`/proc/PID/status`: VmRSS, VmSize",
    sourceDetail:
      'The sampler reads the VmRSS line of `/proc/PID/status` with each resource sample (every 2 s by default) and the VmSize line with each memory sample (every 30 s by default). Check it yourself: `grep -E "VmRSS|VmSize" /proc/PID/status`.',
  },
  rss: {
    title: "Memory (RSS)",
    source: "`/proc/PID/status`: VmRSS, VmHWM, VmSwap",
    sourceDetail:
      'With each resource sample (every 2 s by default), the sampler reads the VmRSS (resident), VmHWM (peak), and VmSwap lines of `/proc/PID/status`. Check it yourself: `grep -E "VmRSS|VmHWM|VmSwap" /proc/PID/status`.',
  },
  vmsize: {
    title: "Virtual size (VmSize)",
    source: "`/proc/PID/status`: VmSize, VmPeak",
    sourceDetail:
      'With each memory sample, the sampler reads VmSize and VmPeak from `/proc/PID/status`. Check it yourself: `grep -E "VmSize|VmPeak" /proc/PID/status`.',
  },
  collsettings: {
    title: "Collector settings",
    source: "Collector: `/api/watches`",
    sourceDetail:
      "This tab reads and writes the collector settings through `/api/watches`. Rules saved here apply to the selected target. They use `data_dir/watch-rules/<hex-key>.json`; the default target that keeps `data_dir/replay` keeps `data_dir/watch-rules.json`.",
  },
  watches: {
    title: "Watch rules",
    source: "[[watch]] in collector.toml, or `data_dir/watch-rules.json`",
    sourceDetail:
      "The collector reads the [[watch]] tables of collector.toml when it starts. Rules saved from this page replace them for the selected target until Reset. Target files are in `data_dir/watch-rules/`; the default target that keeps `data_dir/replay` keeps `data_dir/watch-rules.json`. This page reads the rules in force from `/api/watches`.",
  },
  watchsource: {
    title: "Where the watch rules come from",
    source: "[[watch]] in collector.toml, or `data_dir/watch-rules.json`",
    sourceDetail:
      "The collector reports which file the rules in force came from through `/api/watches`.",
  },
  watchprefix: {
    title: "Thread name prefix",
    meaning:
      "The start of the thread names the rule applies to. A rule matches every thread whose name begins with these characters, with the same upper and lower case.",
    source: "",
    sourceDetail: "",
  },
  watchwake: {
    title: "Wakes at least every (ms)",
    meaning:
      "The longest time a matching thread may go without running before it counts as stuck. Workers that wait with a timeout wake at least this often.",
    source: "",
    sourceDetail: "",
  },
  watchmatch: {
    title: "Matching threads now",
    source: "Thread names from the latest live update",
    sourceDetail:
      "This page counts the thread names (field 2 of `/proc/PID/task/TID/stat`) in the latest live update that start with each prefix.",
  },
  watchremove: {
    title: "Remove a watch rule",
    meaning:
      "Takes this rule out of the list you are editing. Nothing changes on the collector until you select Save.",
    source: "",
    sourceDetail: "",
  },
  watchadd: {
    title: "Add watch rule",
    meaning: "Adds an empty row for a new prefix and interval.",
    source: "",
    sourceDetail: "",
  },
  watchsave: {
    title: "Save watch rules",
    meaning:
      "Applies the whole list in the table to the collector at once and saves it on the collector host, replacing the config file rules. Save is off while any field has a problem, or when nothing has changed and the last save was confirmed.",
    source: "",
    sourceDetail: "",
  },
  watchreload: {
    title: "Reload current watch rules",
    meaning:
      "Loads the current saved rules after another user changed them, or after the collector restarted. Your save or reset was refused so it could not overwrite that change.",
    source: "",
    sourceDetail: "",
  },
  watchreset: {
    title: "Reset watch rules",
    meaning:
      "Deletes the rules saved from this dashboard, and returns to the [[watch]] rules in collector.toml. You are asked to confirm because this discards the dashboard rules and any unsaved edits.",
    source: "",
    sourceDetail: "",
  },
  watched: {
    title: "Watched threads",
    source: "Collector: when each thread last ran; rules from `/api/watches`",
    sourceDetail:
      "The collector records when each thread last ran: the latest sample in which its `schedstat` switch count or its CPU ticks in `stat` changed. The rules come from `/api/watches`: the [[watch]] tables in collector.toml, or the rules saved from this page.",
  },
  procinfo: {
    title: "Process details",
    source: "`/proc/PID/cmdline`, `exe`, `cwd`, `stat`, and `status`",
    sourceDetail:
      "When monitoring starts and every 10 seconds after that, the sampler reads `/proc/PID/cmdline`, the links `/proc/PID/exe` and `/proc/PID/cwd`, fields 4 and 22 of `/proc/PID/stat`, and the Uid, Gid, and Cpus_allowed_list lines of `/proc/PID/status`. The topic of each value names its file.",
  },
  cmdline: {
    title: "Command line",
    source: "`/proc/PID/cmdline`",
    sourceDetail:
      "The sampler reads `/proc/PID/cmdline`, where the kernel separates the arguments with zero bytes, and joins them with spaces. Check it yourself: `ps -o args= -p PID`.",
  },
  exe: {
    title: "Executable",
    source: "Link `/proc/PID/exe`",
    sourceDetail:
      'The sampler reads the symbolic link `/proc/PID/exe`. The kernel adds " (deleted)" when the file was removed or replaced. Check it yourself: `readlink /proc/PID/exe`.',
  },
  cwd: {
    title: "Working directory",
    source: "Link `/proc/PID/cwd`",
    sourceDetail:
      "The sampler reads the symbolic link `/proc/PID/cwd`. Check it yourself: `readlink /proc/PID/cwd`.",
  },
  started: {
    title: "Started",
    source: "`/proc/PID/stat`: field 22 (starttime)",
    sourceDetail:
      "Field 22 of `/proc/PID/stat` is the start time in clock ticks after boot. The sampler adds the wall-clock time of boot (CLOCK_REALTIME minus CLOCK_BOOTTIME). Check it yourself: `ps -o lstart= -p PID`.",
  },
  parentpid: {
    title: "Parent process",
    source: "`/proc/PID/stat`: field 4 (ppid)",
    sourceDetail:
      "Field 4 of `/proc/PID/stat`. Check it yourself: `ps -o ppid= -p PID`.",
  },
  owner: {
    title: "User & group",
    source: "`/proc/PID/status`: Uid, Gid",
    sourceDetail:
      'The first two numbers (real and effective) of the Uid and Gid lines of `/proc/PID/status`. Check it yourself: `grep -E "^(Uid|Gid)" /proc/PID/status`.',
  },
  allowedcpus: {
    title: "Allowed CPUs",
    source: "`/proc/PID/status`: Cpus_allowed_list",
    sourceDetail:
      "The Cpus_allowed_list line of `/proc/PID/status`. Check it yourself: `taskset -cp PID`.",
  },
  exitreason: {
    title: "Last process exit",
    source: "`/dev/kmsg`, then the exit status",
    sourceDetail:
      "The sampler reads new kernel log records from `/dev/kmsg` that name the target PID or one of its threads, such as a segfault or an OOM kill. If none names it, the reason comes from the exit status (see Exit status). Reading `/dev/kmsg` can need CAP_SYSLOG when kernel.dmesg_restrict = 1. Check it yourself: `dmesg | grep PID`.",
  },
  exitstatus: {
    title: "Exit status",
    source: "pidfd (PIDFD_GET_INFO), or `/proc/PID/stat` field 52",
    sourceDetail:
      "The sampler opens a pidfd for the target with pidfd_open when it finds it. On Linux 6.15 and later, the PIDFD_GET_INFO ioctl returns the exit status after the parent reaps the process. While the process is a zombie, the sampler can also read field 52 (exit_code) of `/proc/PID/stat`.",
  },
  exitmessages: {
    title: "Kernel messages",
    source: "`/dev/kmsg`",
    sourceDetail:
      "Kernel log records from `/dev/kmsg` that name the process or one of its thread IDs, logged after the sampler found the process. Check it yourself: `dmesg | grep PID`.",
  },
  cpu: {
    title: "CPU",
    source: "`/proc/PID/task/TID/stat`: utime + stime",
    sourceDetail:
      "Each sample, the sampler reads `/proc/PID/task/TID/stat` for every thread. Fields 14 (utime) and 15 (stime) are the CPU time the thread used in user and kernel mode, in clock ticks (usually 100 per second). The collector divides the change between two samples by the time between them. Process CPU sums the threads. `top -H -p PID` reads the same counters.",
  },
  delay: {
    title: "Run delay",
    source: "`/proc/PID/task/TID/schedstat`: second number",
    sourceDetail:
      "Each sample, the sampler reads `/proc/PID/task/TID/schedstat`. Its second number is the total time, in nanoseconds, that the thread was ready to run but waited for a CPU. The collector divides the change between two samples by the time between them. With `status_fallback = true` in sampler.toml, the sampler reads `status` instead, and run delay is not available. Check it yourself: `cat /proc/PID/task/TID/schedstat`.",
  },
  states: {
    title: "Thread states",
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "Field 3 of `/proc/PID/task/TID/stat` is the scheduler state letter. For a sleeping thread, `/proc/PID/task/TID/wchan` names the kernel function it waits in. The collector maps R to Running, D to Kernel wait, and T or t to Stopped. Otherwise it matches the wait channel: futex; epoll, poll, or select; socket functions; pipe or eventfd; and nanosleep. An empty wait channel is No access. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  mix: {
    title: "State mix",
    source: "Collector: counts of classified thread samples",
    sourceDetail:
      "The collector classifies every thread sample as Thread states describes (from `stat` field 3 and `wchan`) and counts the samples in each state over the window.",
  },
  wchan: {
    title: "Wait channel",
    source: "`/proc/PID/task/TID/wchan`",
    sourceDetail:
      "Each sample, the sampler reads `/proc/PID/task/TID/wchan`: the kernel function a sleeping thread waits in. Compiler suffixes such as .constprop.0 are removed. The kernel shows 0 for a running thread and to a reader without access to the target. Check it yourself: `cat /proc/PID/task/TID/wchan`.",
  },
  map: {
    title: "Thread map",
    source: "Thread CPU and state from `/proc/PID/task/TID/stat` and `wchan`",
    sourceDetail:
      "Each tile uses the CPU of the thread from `/proc/PID/task/TID/stat` (utime + stime) and its classified state (see Thread states). Windows longer than Now average the CPU values this tab received.",
  },
  families: {
    title: "Where the CPU goes",
    source:
      "Thread names from `/proc/PID/task/TID/stat`; groups from collector.toml",
    sourceDetail:
      "Name family removes the trailing number from the thread name (field 2 of `/proc/PID/task/TID/stat`, the same as `comm`). Config group uses the [[group]] prefixes in collector.toml. The CPU of each thread comes from utime + stime in `stat`.",
  },
  cores: {
    title: "Core placement",
    source: "`/proc/PID/task/TID/stat`: field 39 (processor)",
    sourceDetail:
      "Each sample, the sampler reads field 39 of `/proc/PID/task/TID/stat`, the CPU on which the thread last ran. CPU use comes from utime + stime in the same file. Check it yourself: `ps -L -o tid,psr,comm -p PID`.",
  },
  group: {
    title: "Group",
    source: "[[group]] prefixes in collector.toml",
    sourceDetail:
      "The collector assigns each thread to the first [[group]] in collector.toml whose prefix starts the thread name, or to ungrouped. The thread name is field 2 of `/proc/PID/task/TID/stat`.",
  },
  history: {
    title: "History",
    source: "Collector five-second summaries, through `/api/history`",
    sourceDetail:
      "The collector combines the samples of each thread into five-second rows and stores them in SQLite day files under `data_dir`. The drawer loads them with `/api/history`. Recent live CPU comes from the updates this tab received.",
  },
  samples: {
    title: "Samples",
    source: "Collector: thread samples in each stored row",
    sourceDetail:
      "The number of thread samples the collector combined into the five-second row.",
  },
  running: {
    title: "Running",
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Running when field 3 of `stat` is R. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  futex: {
    title: "Futex wait",
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Futex wait when the wait channel contains futex. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  poll: {
    title: "Poll / epoll",
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Poll / epoll when the wait channel contains epoll, poll, or select. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  socket: {
    title: "Socket wait",
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Socket wait when the wait channel contains skb, sk_wait, sock, unix_stream, inet_csk, tcp_, or udp_. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  pipe: {
    title: "Pipe / eventfd",
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Pipe / eventfd when the wait channel contains pipe or eventfd. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  sleep: {
    title: "Sleep",
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Sleep when the wait channel contains nanosleep. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  stopped: {
    title: "Stopped",
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Stopped when field 3 of `stat` is T or t. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  other: {
    title: "Other",
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Other when the wait channel matches no other state. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  no_access: {
    title: "No access",
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows No access when the state letter is not R, D, T, or t and the wait channel is empty: it read 0 or could not be read. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  pressure: {
    title: "Pressure stalls (PSI)",
    source: "`/proc/pressure/*` and `/sys/fs/cgroup/CGROUP/*.pressure`",
    sourceDetail:
      "Host values come from `/proc/pressure/cpu`, `memory`, and `io`. Cgroup values come from `cpu.pressure`, `memory.pressure`, and `io.pressure` in the target cgroup directory under `/sys/fs/cgroup`, found from `/proc/PID/cgroup`. Interval values use the change of the cumulative total= stall time; the first sample uses avg10. Check it yourself: `cat /proc/pressure/cpu`.",
  },
  disk: {
    title: "Disk I/O",
    source: "`/proc/PID/io`: read_bytes, write_bytes",
    sourceDetail:
      "With each resource sample, the sampler reads read_bytes and write_bytes from `/proc/PID/io`: bytes the process caused the block layer to read or write, including threads that have ended. The collector divides the change by the interval. The file is readable only when the sampler runs as the target user. Check it yourself: `cat /proc/PID/io`.",
  },
  fds: {
    title: "Open files",
    source: "`/proc/PID/fd` count; `/proc/PID/limits`: Max open files",
    sourceDetail:
      "With each resource sample, the sampler counts the entries of `/proc/PID/fd` and reads the Max open files line (soft and hard) of `/proc/PID/limits`. Check it yourself: `ls /proc/PID/fd | wc -l`.",
  },
  limits: {
    title: "Limits & headroom",
    source: "Each row names its file in its own topic",
    sourceDetail:
      "Open files: `/proc/PID/fd` and `/proc/PID/limits`. Cgroup memory, CPU quota, and tasks: `memory.*`, `cpu.max`, `cpu.stat`, and `pids.*` in the target cgroup directory under `/sys/fs/cgroup`. Socket memory and backlog: `/proc/PID/net/sockstat` and `/proc/sys/net/`. All are read with each resource sample.",
  },
  cgroupmem: {
    title: "Cgroup memory",
    source:
      "`/sys/fs/cgroup/CGROUP/memory.current`, `memory.max`, `memory.high`, `memory.events`",
    sourceDetail:
      "With each resource sample, the sampler reads memory.current, memory.max, memory.high, and the max and oom_kill lines of memory.events in the target cgroup directory. The cgroup path is the last field of `/proc/PID/cgroup` (cgroup v2). Check it yourself: `cat /sys/fs/cgroup$(cut -d: -f3 /proc/PID/cgroup)/memory.current`.",
  },
  throttle: {
    title: "CPU throttling",
    source: "`/sys/fs/cgroup/CGROUP/cpu.stat`: nr_throttled ÷ nr_periods",
    sourceDetail:
      "With each resource sample, the sampler reads nr_periods, nr_throttled, and throttled_usec from cpu.stat, and the quota from cpu.max, in the target cgroup directory. The share is the change in nr_throttled divided by the change in nr_periods.",
  },
  pids: {
    title: "Processes & threads",
    source: "`/sys/fs/cgroup/CGROUP/pids.current`, `pids.max`",
    sourceDetail:
      "With each resource sample, the sampler reads pids.current and pids.max in the target cgroup directory.",
  },
  sockmem: {
    title: "TCP memory",
    source: "`/proc/PID/net/sockstat`; `/proc/sys/net/ipv4/tcp_mem`",
    sourceDetail:
      "TCP and UDP memory in use are the mem values (in pages) of `/proc/PID/net/sockstat`. The thresholds are `/proc/sys/net/ipv4/tcp_mem` and `udp_mem`. The largest buffers are `/proc/sys/net/core/rmem_max` and `wmem_max`. All are read with each resource sample.",
  },
  backlog: {
    title: "Accept backlog",
    source: "sock_diag listener queue; `/proc/sys/net/core/somaxconn`",
    sourceDetail:
      "The sampler lists sockets through sock_diag, the netlink interface that `ss` uses. For a listener, the receive queue is the connections waiting for accept() and the send queue is the backlog limit. somaxconn comes from `/proc/sys/net/core/somaxconn`. Check it yourself: `ss -ltn`.",
  },
  queues: {
    title: "Bytes waiting in the target's sockets",
    source: "sock_diag socket list, matched through `/proc/PID/fd`",
    sourceDetail:
      "With each resource sample, the sampler lists the TCP, UDP, and Unix sockets of its network namespace through sock_diag, the netlink interface that `ss` uses. It keeps the sockets whose inode appears as socket:[INODE] in `/proc/PID/fd` and sums their receive and send queues. A target in another network namespace has no socket queues. Check it yourself: `ss -tanp`.",
  },
  recvq: {
    title: "Recv-Q",
    source: "sock_diag: receive queue and socket memory",
    sourceDetail:
      "Recv-Q is the receive queue that sock_diag reports for the socket, as `ss` shows it. Buffer fill uses the allocated receive memory and the receive buffer size (rmem_alloc and rcvbuf) from the same list, as `ss -m` shows them.",
  },
  sendq: {
    title: "Send-Q",
    source: "sock_diag: send queue and socket memory",
    sourceDetail:
      "Send-Q is the send queue that sock_diag reports for the socket, as `ss` shows it. Buffer fill uses the queued send memory and the send buffer size (wmem_queued and sndbuf) from the same list, as `ss -m` shows them.",
  },
  rtt: {
    title: "RTT",
    source: "sock_diag `tcp_info`: tcpi_rtt",
    sourceDetail:
      "The sampler asks sock_diag for the kernel tcp_info of each TCP socket of the target, which `ss -ti` also shows. RTT is tcpi_rtt, the smoothed round-trip time in microseconds.",
  },
  retrans: {
    title: "TCP retransmits",
    source:
      "Per socket: `tcp_info`; namespace: `/proc/PID/net/snmp` RetransSegs",
    sourceDetail:
      "Per-socket values are tcpi_total_retrans from tcp_info through sock_diag, which `ss -ti` also shows. Namespace values are the Tcp RetransSegs counter of `/proc/PID/net/snmp`.",
  },
  netdrops: {
    title: "Network drops",
    source: "`/proc/PID/net/netstat`, `snmp`, `snmp6`, and `dev`",
    sourceDetail:
      "With each resource sample, the sampler reads counters from `/proc/PID/net/netstat` (TcpExt), `/proc/PID/net/snmp` (Tcp and Udp), `/proc/PID/net/snmp6` (Udp6, added to Udp), and `/proc/PID/net/dev` (every interface except lo). These files describe the network namespace of the target. Each counter topic names its line. Check it yourself: `cat /proc/PID/net/netstat`.",
  },
  endpoint: {
    title: "Socket",
    source: "sock_diag socket list",
    sourceDetail:
      "Kind, state, and the local and peer addresses come from the sock_diag entry of the socket, as `ss -tuxan` lists them. Unix socket paths come from the same list. A socket belongs to the target when its inode appears in `/proc/PID/fd`.",
  },
  sockdrops: {
    title: "Socket drops",
    source: "sock_diag socket memory: drops",
    sourceDetail:
      "The drop count in the socket memory information (SK_MEMINFO_DROPS) of the sock_diag list, which `ss -m` shows as d. The collector shows the change since the previous resource sample.",
  },
  closewait: {
    title: "CLOSE-WAIT",
    source: "sock_diag socket states",
    sourceDetail:
      "The number of target TCP sockets that sock_diag reports in the CLOSE-WAIT state. Check it yourself: `ss -tan state close-wait`.",
  },
  coverage: {
    title: "Data coverage",
    source: "Flags sent with each sample",
    sourceDetail:
      "The sampler marks data it could not read completely, such as a cut socket list or an unreadable file. The collector marks samples as stale when they are old.",
  },
  "net-listen_overflows": {
    title: "Accept queue overflows",
    source: "`/proc/PID/net/netstat` TcpExt: ListenOverflows",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: ListenOverflows. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-listen_drops": {
    title: "Listen drops",
    source: "`/proc/PID/net/netstat` TcpExt: ListenDrops",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: ListenDrops. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_req_q_full_drop": {
    title: "SYN queue full",
    source: "`/proc/PID/net/netstat` TcpExt: TCPReqQFullDrop",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPReqQFullDrop. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-syncookies_sent": {
    title: "SYN cookies sent",
    source: "`/proc/PID/net/netstat` TcpExt: SyncookiesSent",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: SyncookiesSent. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_backlog_drop": {
    title: "Socket backlog drops",
    source: "`/proc/PID/net/netstat` TcpExt: TCPBacklogDrop",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPBacklogDrop. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_rcvq_drop": {
    title: "Receive queue drops",
    source: "`/proc/PID/net/netstat` TcpExt: TCPRcvQDrop",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPRcvQDrop. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_zero_window_drop": {
    title: "Zero-window drops",
    source: "`/proc/PID/net/netstat` TcpExt: TCPZeroWindowDrop",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPZeroWindowDrop. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-prune_called": {
    title: "Receive queue pruning",
    source: "`/proc/PID/net/netstat` TcpExt: PruneCalled",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: PruneCalled. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-rcv_pruned": {
    title: "Packets pruned",
    source: "`/proc/PID/net/netstat` TcpExt: RcvPruned",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: RcvPruned. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-ofo_pruned": {
    title: "Out-of-order pruned",
    source: "`/proc/PID/net/netstat` TcpExt: OfoPruned",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: OfoPruned. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_retrans_segs": {
    title: "Retransmitted segments",
    source: "`/proc/PID/net/snmp` Tcp: RetransSegs",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Tcp: RetransSegs. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_timeouts": {
    title: "Retransmission timeouts",
    source: "`/proc/PID/net/netstat` TcpExt: TCPTimeouts",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPTimeouts. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_abort_on_timeout": {
    title: "Aborted after timeouts",
    source: "`/proc/PID/net/netstat` TcpExt: TCPAbortOnTimeout",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPAbortOnTimeout. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_estab_resets": {
    title: "Connections reset",
    source: "`/proc/PID/net/snmp` Tcp: EstabResets",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Tcp: EstabResets. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_attempt_fails": {
    title: "Failed connection attempts",
    source: "`/proc/PID/net/snmp` Tcp: AttemptFails",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Tcp: AttemptFails. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_memory_pressures": {
    title: "TCP memory pressure",
    source: "`/proc/PID/net/netstat` TcpExt: TCPMemoryPressures",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPMemoryPressures. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_abort_on_memory": {
    title: "Aborted for memory",
    source: "`/proc/PID/net/netstat` TcpExt: TCPAbortOnMemory",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPAbortOnMemory. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-udp_rcvbuf_errors": {
    title: "UDP receive buffer full",
    source:
      "`/proc/PID/net/snmp` Udp: RcvbufErrors, plus Udp6RcvbufErrors in `snmp6`",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Udp: RcvbufErrors, plus Udp6RcvbufErrors in `snmp6`. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-udp_sndbuf_errors": {
    title: "UDP send buffer full",
    source:
      "`/proc/PID/net/snmp` Udp: SndbufErrors, plus Udp6SndbufErrors in `snmp6`",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Udp: SndbufErrors, plus Udp6SndbufErrors in `snmp6`. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-udp_in_errors": {
    title: "UDP input errors",
    source: "`/proc/PID/net/snmp` Udp: InErrors, plus Udp6InErrors in `snmp6`",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Udp: InErrors, plus Udp6InErrors in `snmp6`. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-udp_mem_errors": {
    title: "UDP memory errors",
    source:
      "`/proc/PID/net/snmp` Udp: MemErrors, plus Udp6MemErrors in `snmp6`",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Udp: MemErrors, plus Udp6MemErrors in `snmp6`. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-udp_no_ports": {
    title: "UDP to closed ports",
    source: "`/proc/PID/net/snmp` Udp: NoPorts, plus Udp6NoPorts in `snmp6`",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Udp: NoPorts, plus Udp6NoPorts in `snmp6`. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-if_rx_dropped": {
    title: "Interface receive drops",
    source:
      "`/proc/PID/net/dev` receive drop, summed over interfaces except lo",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/dev` receive drop, summed over interfaces except lo. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-if_tx_dropped": {
    title: "Interface transmit drops",
    source:
      "`/proc/PID/net/dev` transmit drop, summed over interfaces except lo",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/dev` transmit drop, summed over interfaces except lo. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-if_rx_errors": {
    title: "Interface receive errors",
    source:
      "`/proc/PID/net/dev` receive errs, summed over interfaces except lo",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/dev` receive errs, summed over interfaces except lo. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-if_tx_errors": {
    title: "Interface transmit errors",
    source:
      "`/proc/PID/net/dev` transmit errs, summed over interfaces except lo",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/dev` transmit errs, summed over interfaces except lo. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  memmap: {
    title: "Memory map",
    source: "`/proc/PID/maps` and `/proc/PID/status`",
    sourceDetail:
      "The sampler reads `/proc/PID/maps` every other memory sample and reads the Vm lines of `/proc/PID/status` with every sample. The collector serves the layout through `/api/memory-map`. Check it yourself: `cat /proc/PID/maps`.",
  },
  memkinds: {
    title: "Anonymous / file / shared",
    source: "`/proc/PID/status`: RssAnon, RssFile, RssShmem",
    sourceDetail:
      "With each resource sample, the sampler reads RssAnon, RssFile, and RssShmem from `/proc/PID/status`. Their sum is VmRSS.",
  },
  vmas: {
    title: "Mappings (VMAs)",
    source: "Lines of `/proc/PID/maps`; `/proc/sys/vm/max_map_count`",
    sourceDetail:
      "Each line of `/proc/PID/maps` is one VMA. The sampler counts them every other memory sample. The last count remains visible between scans, with its age relative to the latest sample. The limit is `/proc/sys/vm/max_map_count`. Check it yourself: `wc -l < /proc/PID/maps`.",
  },
  memfindings: {
    title: "Memory findings",
    source: "Computed in this page",
    sourceDetail:
      "This page applies fixed rules to the latest memory, resource, and thread samples. Each finding names the value it used.",
  },
  amap: {
    title: "Address space map",
    source: "`/proc/PID/maps`",
    sourceDetail:
      "Each bar groups adjacent lines of `/proc/PID/maps` of the same kind. The kind comes from the path column ([heap], [stack], a file, or none for anonymous memory) and the permissions.",
  },
  memzoom: {
    title: "Region zoom",
    source: "`/proc/PID/maps`; page size of the sampler host",
    sourceDetail:
      "The grid shows the address ranges of `/proc/PID/maps`. The page size is sysconf(_SC_PAGESIZE) on the sampler host.",
  },
  memgap: {
    title: "Largest unmapped gap",
    source: "Computed from `/proc/PID/maps`",
    sourceDetail:
      "The longest range inside the bar that no line of `/proc/PID/maps` covers.",
  },
  heapmargin: {
    title: "Heap display margin",
    source: "Display range around the [heap] line of `/proc/PID/maps`",
    sourceDetail:
      "A display choice of this page. The addresses come from `/proc/PID/maps`.",
  },
  heap: {
    title: "Heap size",
    source: "The [heap] line of `/proc/PID/maps`",
    sourceDetail:
      "The size of the [heap] line of `/proc/PID/maps` (end address minus start address) in each memory sample. Check it yourself: `grep heap /proc/PID/maps`.",
  },
  heapend: {
    title: "Heap mapping end",
    source: "End address of the [heap] line of `/proc/PID/maps`",
    sourceDetail:
      "The end address of the [heap] line of `/proc/PID/maps` in each memory sample.",
  },
  stackstart: {
    title: "Main stack start",
    source: "Start address of the [stack] line of `/proc/PID/maps`",
    sourceDetail:
      "The start address of the [stack] line of `/proc/PID/maps` in each memory sample.",
  },
  vmdata: {
    title: "Data + heap (VmData)",
    source: "`/proc/PID/status`: VmData",
    sourceDetail:
      "With each memory sample, the sampler reads the VmData line of `/proc/PID/status`.",
  },
  stack: {
    title: "Main stack",
    source: "[stack] in `/proc/PID/maps`; `/proc/PID/limits`: Max stack size",
    sourceDetail:
      "The size of the [stack] line of `/proc/PID/maps`, compared with the soft Max stack size of `/proc/PID/limits`. Check it yourself: `grep stack /proc/PID/maps`.",
  },
  aslimit: {
    title: "Address space limit",
    source: "`/proc/PID/limits`: Max address space",
    sourceDetail:
      "The soft value of the Max address space line of `/proc/PID/limits`. Check it yourself: `prlimit --as --pid PID`.",
  },
  anonres: {
    title: "Resident anonymous",
    source: "`/proc/PID/status`: RssAnon",
    sourceDetail:
      "With each resource sample (every 2 s by default), the sampler reads the RssAnon line of `/proc/PID/status`.",
  },
  threadstacks: {
    title: "Thread stacks",
    source: "Anonymous lines of `/proc/PID/maps`",
    sourceDetail:
      "The dashboard does not measure the residency of each thread stack. Thread stacks appear as anonymous lines in `/proc/PID/maps`, usually with a guard page below them.",
  },
  memregions: {
    title: "Memory regions",
    source: "`/proc/PID/maps`",
    sourceDetail:
      "The start address, size, and permissions of the merged lines of `/proc/PID/maps`.",
  },
  memlimits: {
    title: "Memory limits & headroom",
    source:
      "`/proc/PID/limits`, `/proc/PID/status`, `/proc/sys/vm/max_map_count`",
    sourceDetail:
      "Max address space and Max stack size come from `/proc/PID/limits`. VmPTE (page tables) and VmLck (locked) come from `/proc/PID/status`. The mapping limit is `/proc/sys/vm/max_map_count`. The sampler measures the time of its own maps reads.",
  },
  faulttotals: {
    title: "Page faults since start",
    source: "`/proc/PID/stat`: fields 10 (minflt) and 12 (majflt)",
    sourceDetail:
      "With each memory sample (every 30 s by default), the sampler reads fields 10 and 12 of `/proc/PID/stat`: the minor and major faults of the whole process since it started, including threads that have ended. Check it yourself: `ps -o min_flt,maj_flt -p PID`.",
  },
} as const;

export type HelpTopicId = keyof typeof topics;
export const helpTopics: Readonly<Record<HelpTopicId, HelpTopic>> = topics;
export const helpTopicIds = Object.keys(topics).filter(isHelpTopicId);

export function isHelpTopicId(value: string): value is HelpTopicId {
  return Object.hasOwn(helpTopics, value);
}
