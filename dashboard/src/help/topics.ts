export interface HelpTopic {
  title: string;
  scope: string;
  meaning: string;
  example: string;
  reading: string;
  limits: string;
  related: readonly string[];
  aliases: readonly string[];
  source: string;
  sourceDetail: string;
}

export const helpTopics = {
  "fleet-filter": {
    title: "Find targets",
    scope: "This browser tab · Targets overview",
    meaning:
      "Search shows the tiles whose process name, host, or target ID contains the text. Status shows the tiles at one assessment level, or Needs attention for critical, serious, and warning.",
    example:
      "Search db with Status Critical shows only critical targets whose name, host, or ID contains db.",
    reading:
      "Showing N of M targets counts the tiles that match out of every monitored target. The count pills always total all targets. Clear filters shows every tile again. The page address keeps the search and status, and target links carry them, so a copied link, browser Back, and All targets on a target dashboard return to the same view. Add target stays available when no tile matches.",
    limits:
      "Search and status only show or hide tiles: they start no request and do not change monitoring. A tile with keyboard focus keeps its last level until focus leaves it, so it can stay shown or hidden until the next refresh.",
    related: ["fleet", "fleet-tile", "fleet-density"],
    aliases: ["Find target", "Needs attention"],
    source: "",
    sourceDetail: "",
  },
  "fleet-density": {
    title: "Tile density",
    scope: "This browser · Targets overview",
    meaning: "Select Comfortable or Compact target tiles.",
    example:
      "Compact tiles start at 200 px wide and 104 px tall, instead of 240 px and 140 px, so more targets fit on one screen.",
    reading:
      "Comfortable uses larger tiles and gaps. Compact uses smaller tiles, gaps, and padding with the same text and controls. Your selection is saved in this browser. The number of targets and the 5-second refresh never change it.",
    limits:
      "If browser storage is blocked, the selection lasts only until the page reloads. Density does not change assessments or which targets show.",
    related: ["fleet", "fleet-tile", "appearance"],
    aliases: ["Tile density"],
    source: "",
    sourceDetail: "",
  },
  "fleet-tile": {
    title: "Target tile",
    scope: "One target · latest live view",
    meaning:
      "The process name, host and target ID identify the target. A long name ends with an ellipsis; point at it to see the full name. One dot shows the assessment of its latest live view: red critical, orange serious, amber warning, green healthy, gray no data. The dot and colored edge use the same assessment. The dot does not show sampler activity.",
    example:
      "An orange dot means a serious finding, even when the sampler is sending data.",
    reading:
      "Point at a problem tile, or move keyboard focus to it, for up to four findings with details and the process PID. Open the tile for all findings, CPU, memory, thread counts, update times, access limits, and sampler throttle status.",
    limits:
      "Tiles do not run trend rules for thread growth, thread churn, or long futex waits, or memory-map layout rules. The dashboard can show more findings. A focused tile keeps its last values until focus leaves and the next refresh runs.",
    related: [
      "fleet",
      "assessment",
      "assesshistory",
      "target-access",
      "sampler-budget",
    ],
    aliases: ["Target tiles"],
    source:
      "Collector: `/api/targets` and `/api/live?target=host/id`; assessment computed in this page",
    sourceDetail:
      "The name and status come from the target list and latest live view. Findings use the same rules as the Assessment card. The process dashboard shows the measurements and monitoring details.",
  },

  target: {
    title: "Process name or PID",
    scope: "Target selection",
    meaning:
      "An exact process name follows matching process restarts. A PID selects one running process.",
    example: "worker-service selects an exact name; 1234 selects a process ID.",
    reading:
      "A name with no running match is accepted and waits for the process. An ambiguous name is rejected. Changes apply without a sampler restart.",
    limits:
      "Linux process names are limited to 15 bytes. A thread ID is not a process ID.",
    related: ["session", "health"],
    aliases: ["Change target"],
    source:
      "Sampler `[[target]]` tables or legacy `target_process` and `target_pid`; names match `/proc/PID/comm`",
    sourceDetail:
      "Manage targets and `scripts/set-target.sh` write the configuration and ask the sampler to reload. For a name, the sampler compares it with `/proc/PID/comm` of every process. Check it yourself: `pgrep -x NAME`.",
  },
  "target-switch": {
    title: "Monitoring target",
    scope: "This browser tab",
    meaning: "Select the host and target ID shown in this tab.",
    example: "Two tabs can show different processes.",
    reading:
      "The URL stores the choice. A switch resets filters, the selected thread, charts, memory view, and replay position. All targets returns to the overview of every target.",
    limits: "Viewing a target does not change the sampler.",
    related: ["target", "manage-targets"],
    aliases: ["Selected monitoring target"],
    source: "Collector: `/api/targets`; URL `?target=host/id`",
    sourceDetail:
      "TTGT announcements identify each host and target ID. The collector routes sessions and returns target metadata. This tab adds the selected key to its API requests.",
  },
  appearance: {
    title: "Color theme",
    scope: "This browser",
    meaning: "Select System, Light, or Dark for the dashboard.",
    example:
      "System uses the light or dark appearance selected by your operating system.",
    reading:
      "Use Light for a bright workspace or Dark for a dim workspace. Your selection is saved in this browser and applies to all dashboard sections.",
    limits:
      "If browser storage is blocked, the selection lasts only until the page reloads. Theme changes do not change measurements or status meanings.",
    related: ["page"],
    aliases: [],
    source: "",
    sourceDetail: "",
  },
  "section-navigation": {
    title: "Section navigation",
    scope: "Dashboard page",
    meaning:
      "The highlighted tab identifies the section at the top of the visible page.",
    example: "",
    reading:
      "Select a tab to go to its section. The highlight changes when you scroll.",
    limits:
      "At the bottom of the page, the last tab (Settings) is highlighted.",
    related: [],
    aliases: [],
    source: "",
    sourceDetail: "",
  },
  health: {
    title: "Monitor health",
    scope: "Sampler and collector",
    meaning:
      "Connection status, sample timing, packet handling, and retained observations.",
    example: "",
    reading:
      "Check monitor health before interpreting gaps or a lack of activity.",
    limits:
      "A connected sampler does not guarantee complete data. Silence and packet loss can limit every metric.",
    related: ["loss", "interval", "session"],
    aliases: [
      "Sampler",
      "Last data",
      "Last sample",
      "Sampler address",
      "Monitor diagnostics (raw health JSON)",
    ],
    source: "Collector: datagrams received from the sampler",
    sourceDetail:
      "The collector counts the UDP datagrams it receives from the sampler: when the last one arrived, their session, sequence gaps, and rejected packets. It serves the result in `/api/live`. Nothing here is read from the target process.",
  },
  fleet: {
    title: "Targets overview",
    scope: "Every target of this collector · latest live view",
    meaning:
      "The first page: one tile per monitored process, with its current assessment. The counts above the tiles total every target by level, including targets that a search or status hides.",
    example:
      "Critical 1 · Healthy 3 means one process needs attention now and three show no problem.",
    reading:
      "Tiles are sorted worst first, then by host and target ID. Select a tile, or open it in a new tab, to see that process's dashboard; All targets on the dashboard returns here. The tab title starts with the number of targets at warning or worse. The page refreshes every 5 seconds while it is visible.",
    limits:
      "Tiles do not run trend rules or memory-map layout rules. Each refresh reads the latest live view of every target, so a large number of targets costs more network traffic than one dashboard.",
    related: ["fleet-tile", "target-switch", "assessment"],
    aliases: ["All targets", "Targets"],
    source:
      "Collector: `/api/targets` and `/api/live?target=host/id` for each target",
    sourceDetail:
      "The page reads the target list, then the latest live view of each target, at most 4 at a time, every 5 seconds.",
  },
  overview: {
    title: "Process overview",
    scope: "Target process · summed thread observations",
    meaning:
      "A summary of the target process, computed from its reported threads.",
    example: "",
    reading:
      "Use load, CPU use, state counts, and wait channels together. Live overview trends are retained in this browser tab for up to 15 minutes. Recorded views show one saved process view.",
    limits:
      "Browser trends are not the same as stored thread history. Missing observations can limit every total.",
    related: ["load", "cpu", "health"],
    aliases: [],
    source: "Thread samples from `/proc/PID/task/TID/`, summed",
    sourceDetail:
      "The tiles sum the values of the threads: CPU and faults from `stat`, run delay and switches from `schedstat`, read and write bytes from `io`, and states from `stat` and `wchan`. Socket bytes come from the optional eBPF observer.",
  },
  assessment: {
    title: "Assessment",
    scope: "Fixed rules applied to observed data",
    meaning: "A summary of conditions that deserve inspection.",
    example: "",
    reading:
      "Examples include CPU at or above 90% of a core, run delay over one quarter of CPU time, kernel waits, major faults, and packet loss over 1%. Watched-thread rules (see Watched threads) add findings for a thread that stopped waking up, a watched thread that is busy, and a rule that matches no thread. Read the specific finding and its scope. The card lists the most severe findings first and shows up to 8; Show more lists the rest until you select Show fewer.",
    limits:
      "These are rules of thumb, not a diagnosis. Check workload expectations and measurement coverage before changing configuration.",
    related: ["watched", "health", "cpu", "pressure"],
    aliases: ["What it means"],
    source: "Computed in this page from the displayed data",
    sourceDetail:
      "This page applies fixed rules to the values it shows: thread samples, resource samples, memory samples, and monitor health. Each finding names the value it used; the topic of that value gives its source.",
  },
  active: {
    title: "Active threads",
    scope: "Threads · preceding ~10 seconds",
    meaning:
      "Threads with recent CPU use, context switches, or I/O. Blocked or stopped threads are not treated as idle.",
    example: "An idle worker can still be waiting normally for its next task.",
    reading:
      "Active, Idle, and All change which threads are listed. Clear filters to restore the default view.",
    limits:
      "Idle does not mean exited. A sampling gap is not evidence of inactivity.",
    related: ["states", "switches"],
    aliases: [
      "Activity",
      "Threads",
      "Active",
      "Idle",
      "All",
      "Which threads to show",
    ],
    source: "Thread counters in `/proc/PID/task/TID/`",
    sourceDetail:
      "A thread is active when, in the preceding ~10 seconds, it used CPU (`stat` utime + stime), was put on a CPU (`schedstat`), read or wrote (`io` rchar, wchar), had a major fault (`stat` majflt), or was sampled running, in kernel wait, or stopped. The collector computes the rates; this page applies the rule.",
  },
  switches: {
    title: "Context switches",
    scope: "Events per second",
    meaning:
      "How often the scheduler switches execution to or from the observed threads.",
    example: "200/s means 200 context switches per elapsed second.",
    reading:
      "Compare changes with CPU use and wait states. Frequent switching can accompany normal I/O or synchronization.",
    limits:
      "This rate alone does not identify overhead or distinguish every reason for a switch.",
    related: ["cpu", "states"],
    aliases: ["Switches/s"],
    source: "`/proc/PID/task/TID/schedstat`: third number",
    sourceDetail:
      "The third number in `/proc/PID/task/TID/schedstat` counts how many times the scheduler put the thread on a CPU. The collector divides its change by the time between samples. With `status_fallback = true`, the sampler reads voluntary_ctxt_switches from `/proc/PID/task/TID/status` instead. Check it yourself: `cat /proc/PID/task/TID/schedstat`.",
  },
  sysio: {
    title: "Disk & syscall I/O",
    scope: "Thread or process · bytes per second",
    meaning:
      "Traffic counted by the sampled read- and write-family system-call counters.",
    example: "1 KiB/s is 1,024 bytes counted per elapsed second.",
    reading:
      "Use the resource Disk I/O panel for block-layer activity. Use Socket I/O for explicitly observed socket operations.",
    limits:
      "These counters do not cover every receive API and are not a measure of bytes transferred by the disk device.",
    related: ["disk", "socketio"],
    aliases: ["Read/s", "Write/s", "I/O"],
    source: "`/proc/PID/task/TID/io`: rchar, wchar",
    sourceDetail:
      "Each sample, the sampler reads the rchar and wchar lines of `/proc/PID/task/TID/io`: bytes passed to read- and write-family system calls, including sockets, pipes, and cached files. The collector divides the change by the time between samples. Process values sum the threads. The file is readable only when the sampler runs as the target user. Check it yourself: `cat /proc/PID/task/TID/io`.",
  },
  faults: {
    title: "Major faults",
    scope: "Faults per second",
    meaning: "Page faults that required I/O to bring a page into memory.",
    example: "2/s means two major page faults per elapsed second.",
    reading:
      "Compare a sustained increase with memory pressure, RSS, and disk I/O.",
    limits:
      "A major fault is not an application crash. A single fault does not prove memory pressure.",
    related: ["rss", "pressure", "disk"],
    aliases: ["Maj. faults/s", "Major faults/s"],
    source: "`/proc/PID/task/TID/stat`: field 12 (majflt)",
    sourceDetail:
      "Each sample, the sampler reads field 12 of `/proc/PID/task/TID/stat`, the count of major page faults of the thread. The collector divides its change by the time between samples. Process values sum the threads.",
  },
  churn: {
    title: "Thread churn",
    scope: "Process · preceding minute",
    meaning:
      "Threads seen starting or ending during the last minute. This is a lower bound: a thread is counted only if a sample catches it alive.",
    example:
      "+4 / −2 means four starts and two ends were seen. +0 / −0 means none were seen, not that none happened.",
    reading:
      "Compare sustained churn with worker-pool behavior and process restarts. If the process creates short-lived threads, expect the real number to be higher, often far higher.",
    limits:
      "A thread that starts and exits between two samples is never seen, and the kernel offers no unprivileged count of threads created. At 2 samples/s, a thread living 10 ms is seen about 2% of the time. Raise the sample rate, or count thread creations inside the application.",
    related: ["thread", "health"],
    aliases: [],
    source: "Thread IDs in `/proc/PID/task`, compared between updates",
    sourceDetail:
      "Each sample, the sampler lists `/proc/PID/task`, which has one entry per live thread. This page compares the thread IDs of consecutive live updates: a new ID counts as a start and a missing ID as an end. The kernel keeps no count of created threads that an unprivileged reader can see.",
  },
  load: {
    title: "Process load",
    scope: "Process · 1-, 5-, and 15-minute averages",
    meaning:
      "Smoothed demand from CPU use, runnable delay, and threads in uninterruptible kernel wait.",
    example: "1.00 represents about one core of demand.",
    reading:
      "Compare the three averages to see whether demand is increasing. The chart window controls what is visible, not the averaging period.",
    limits:
      "This estimate covers the target process. It is not the host load average. Live averages need observations in this browser tab.",
    related: ["cpu", "delay", "kernel"],
    aliases: ["1-minute load"],
    source:
      "Computed in this page from thread CPU, run delay, and kernel waits",
    sourceDetail:
      "This page computes it from each live update: the CPU use and run delay of all threads (from `stat` and `schedstat`), plus the number of threads in uninterruptible kernel wait (state D in `stat`). It applies the same exponential averaging that the kernel uses for `/proc/loadavg`, but only to this process.",
  },
  cpucores: {
    title: "On CPU now",
    scope: "Process · CPU cores",
    meaning: "The sum of thread CPU time, expressed in cores used.",
    example: "1.5 cores means 1.5 seconds of CPU time per elapsed second.",
    reading: "Compare CPU cores used with process load and runnable demand.",
    limits: "This is CPU use by the process, not the number of host cores.",
    related: ["cpu", "load"],
    aliases: ["On CPU"],
    source: "`/proc/PID/task/TID/stat`: utime + stime, summed",
    sourceDetail:
      "The sum of thread CPU (see CPU) divided by 100: CPU seconds per elapsed second.",
  },
  demand: {
    title: "Waiting for CPU",
    scope: "Process · percentage of runnable demand",
    meaning:
      "Run delay as a share of CPU time plus run delay, summed across reported threads.",
    example:
      "With 0.75 seconds on CPU and 0.25 seconds waiting, the share is 25%.",
    reading:
      "Compare this share with the thread-table Run delay metric, whose denominator is elapsed time.",
    limits:
      "Very low demand makes this ratio unstable. The display uses negligible below 1% of one core of demand.",
    related: ["delay", "cpucores", "pressure"],
    aliases: [],
    source: "`stat` CPU and `schedstat` run delay, summed",
    sourceDetail:
      "Summed over all threads: run delay (the second number of `/proc/PID/task/TID/schedstat`) divided by CPU time (utime + stime of `stat`) plus run delay.",
  },
  thread: {
    title: "Thread / TID",
    scope: "Thread identity",
    meaning: "The Linux thread name and thread ID identify a reported thread.",
    example: "",
    reading:
      "Select a row or map tile to open its history. Search matches the name, TID, and wait channel.",
    limits:
      "Linux can reuse a TID. Stored history also uses the thread generation and sampler session.",
    related: ["history", "session"],
    aliases: ["Thread", "Busiest thread", "Find socket thread"],
    source: "`/proc/PID/task` and `stat` field 2 (comm)",
    sourceDetail:
      "The thread IDs are the entries of `/proc/PID/task`. The name is field 2 of `/proc/PID/task/TID/stat`, the same as `/proc/PID/task/TID/comm`, which the kernel cuts to 15 bytes. The collector adds a generation number when a TID is reused. Check it yourself: `ls /proc/PID/task`.",
  },
  kernel: {
    title: "Kernel wait (D)",
    scope: "Thread · sampled state",
    meaning: "The scheduler reports uninterruptible kernel wait.",
    example: "",
    reading: "Compare the wait channel and recent thread history.",
    limits:
      "This often involves I/O, but the state alone cannot identify the device or cause.",
    related: ["states", "wchan"],
    aliases: [],
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Kernel wait (D) when field 3 of `stat` is D. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  "memory-use": {
    title: "Memory use",
    scope: "Target process · selected chart window",
    meaning:
      "Resident memory (RSS) is physical memory held by the process. Virtual size (VmSize) is its mapped address space.",
    example: "A process can map 1 GiB while only 100 MiB is resident.",
    reading:
      "Compare both charts over the same period as Process load. Open Memory for mappings and memory findings.",
    limits:
      "Mapped memory is not the same as physical use. Missing samples are gaps, not zero.",
    related: ["rss", "vmsize", "memmap"],
    aliases: [],
    source: "`/proc/PID/status`: VmRSS, VmSize",
    sourceDetail:
      'The sampler reads the VmRSS line of `/proc/PID/status` with each resource sample (every 2 s by default) and the VmSize line with each memory sample (every 30 s by default). Check it yourself: `grep -E "VmRSS|VmSize" /proc/PID/status`.',
  },
  rss: {
    title: "Memory (RSS)",
    scope: "Process · bytes in RAM",
    meaning: "Resident set size is the process memory currently held in RAM.",
    example: "",
    reading:
      "Compare current RSS with its peak, swap use, and growth. Use memory pressure to understand stalls.",
    limits:
      "Shared pages count in full. RSS differs from private memory and cgroup memory. Growth alone does not establish a leak. The Summary chart steps once per resource sample (2 s by default) and covers only the time this tab was open.",
    related: ["pressure", "cgroupmem", "vmsize"],
    aliases: ["Resident (RSS)", "Resident memory (RSS)"],
    source: "`/proc/PID/status`: VmRSS, VmHWM, VmSwap",
    sourceDetail:
      'With each resource sample (every 2 s by default), the sampler reads the VmRSS (resident), VmHWM (peak), and VmSwap lines of `/proc/PID/status`. Check it yourself: `grep -E "VmRSS|VmHWM|VmSwap" /proc/PID/status`.',
  },
  vmsize: {
    title: "Virtual size (VmSize)",
    scope: "Process · mapped bytes",
    meaning:
      "The total size of every mapping in the address space, whether or not it is in RAM.",
    example:
      "A 1 GB reservation that is never touched adds 1 GB here and almost nothing to RSS.",
    reading:
      "Compare with RLIMIT_AS and the peak. Large values are common for runtimes that reserve address space up front.",
    limits:
      "Virtual size is not memory use. Growth alone does not establish a leak. The Summary chart steps once per memory sample (30 s by default) and covers only the time this tab was open.",
    related: ["aslimit", "rss", "vmas"],
    aliases: ["Peak virtual size", "Share of VmSize"],
    source: "`/proc/PID/status`: VmSize, VmPeak",
    sourceDetail:
      'With each memory sample, the sampler reads VmSize and VmPeak from `/proc/PID/status`. Check it yourself: `grep -E "VmSize|VmPeak" /proc/PID/status`.',
  },
  watched: {
    title: "Watched threads",
    scope: "Threads that match a watch rule · wake interval",
    meaning:
      "A watch rule says that threads whose name starts with a prefix wake at least every N milliseconds, as workers that wait with a timeout do. The dashboard compares each such thread with its rule: the finding “stopped waking up” means it has not run for much longer than that interval, “is running instead of sleeping” means it uses 90% of a core or more, and “watch rule matches no thread” means no current thread has that prefix. “Watched: wakes at least every N ms” in a thread's details shows its rule and when it last ran.",
    example:
      "Rule worker- with 500 ms. worker-3 last ran 4.2 s before the latest sample, so the Assessment says it stopped waking up. Stopped waking means more than twice the interval plus two sample intervals; at 500 ms and 200 ms sampling that is 1.4 s.",
    reading:
      "The time without running is counted between samples, not against the browser clock, so a paused sampler or a recorded view does not cause an alarm. A stuck thread may be deadlocked or may wait without a timeout: open it and check its wait channel, then take a stack dump to name the lock. A busy one may be in an infinite or retry loop. For a rule with no thread, check the prefix or whether the threads exited or were renamed. When every watched thread ran on time, one line says so.",
    limits:
      "The check sees whether a thread ran, not whether it did useful work, so a thread that wakes on its timer but never makes progress looks healthy. A thread that sleeps longer than its rule by design is flagged; set the rule to the longest sleep. Stale threads, a silent sampler and an absent target are not checked. In a recorded view on the Timeline and in the final view of an ended target the recorded rules are used and the unmatched-rule check is skipped. Rules come from collector.toml or the ones saved from the dashboard.",
    related: ["assessment", "states", "wchan", "thread"],
    aliases: ["Watched", "Stopped waking", "Watch rule"],
    source: "Collector: when each thread last ran; rules from `/api/watches`",
    sourceDetail:
      "The collector records when each thread last ran: the latest sample in which its `schedstat` switch count or its CPU ticks in `stat` changed. The rules come from `/api/watches`: the [[watch]] tables in collector.toml, or the rules saved from this page.",
  },
  procinfo: {
    title: "Process details",
    scope: "Target process · read when monitoring starts",
    meaning:
      "What the target is: its command line, program file, working directory, start time, parent, owner, and allowed CPUs.",
    example: "",
    reading:
      "Use it to confirm that you are watching the intended process, for example the right instance of a name that runs several times.",
    limits:
      "The sampler reads these values from /proc when it starts watching a process and sends them again every 10 seconds. It does not read them again, so a later change of directory or CPU affinity does not show. Values the sampler may not read show Not available.",
    related: ["cmdline", "exe", "started"],
    aliases: [],
    source: "`/proc/PID/cmdline`, `exe`, `cwd`, `stat`, and `status`",
    sourceDetail:
      "When monitoring starts, the sampler reads `/proc/PID/cmdline`, the links `/proc/PID/exe` and `/proc/PID/cwd`, fields 4 and 22 of `/proc/PID/stat`, and the Uid, Gid, and Cpus_allowed_list lines of `/proc/PID/status`. The topic of each value names its file.",
  },
  cmdline: {
    title: "Command line",
    scope: "Target process · /proc/PID/cmdline",
    meaning:
      "The program and arguments the process was started with, joined by spaces.",
    example: '"/usr/bin/app --port 8080" is the program with one option.',
    reading:
      "The process name in the page header is cut at 15 characters; the command line is not. The arguments show how this instance was configured.",
    limits:
      "An argument that contains a space looks like two arguments. A long command line is cut and ends with …. The process can rewrite its own command line. The text is shown as the process has it, so a secret passed as an argument is visible here.",
    related: ["procinfo", "exe"],
    aliases: [],
    source: "`/proc/PID/cmdline`",
    sourceDetail:
      "The sampler reads `/proc/PID/cmdline`, where the kernel separates the arguments with zero bytes, and joins them with spaces. Check it yourself: `ps -o args= -p PID`.",
  },
  exe: {
    title: "Executable",
    scope: "Target process · /proc/PID/exe",
    meaning: "The program file the process is running.",
    example:
      '"/usr/bin/app (deleted)" means the file was removed or replaced after the process started.',
    reading:
      "A (deleted) suffix usually means the program was upgraded while it ran. The process keeps running the old version until it restarts.",
    limits:
      "Readable only when the sampler runs as the target user and the process allows it. Otherwise it shows Not available. A long path is cut at the start and begins with ….",
    related: ["procinfo", "cwd"],
    aliases: [],
    source: "Link `/proc/PID/exe`",
    sourceDetail:
      'The sampler reads the symbolic link `/proc/PID/exe`. The kernel adds " (deleted)" when the file was removed or replaced. Check it yourself: `readlink /proc/PID/exe`.',
  },
  cwd: {
    title: "Working directory",
    scope: "Target process · /proc/PID/cwd",
    meaning: "The directory that relative file names resolve against.",
    example: "",
    reading: "It helps explain where relative files, logs, and core dumps go.",
    limits:
      "The same read limits apply as for Executable. The process can change directory later; the value is the one read at the start.",
    related: ["procinfo", "exe"],
    aliases: [],
    source: "Link `/proc/PID/cwd`",
    sourceDetail:
      "The sampler reads the symbolic link `/proc/PID/cwd`. Check it yourself: `readlink /proc/PID/cwd`.",
  },
  started: {
    title: "Started",
    scope: "Target process · wall-clock time",
    meaning:
      "When the process started, and how long it had run at the time shown.",
    example:
      '"up 3.2 h" means it started about 3.2 hours before the displayed time.',
    reading:
      "A later start than expected means the process restarted. In a recorded view, the run time is counted to the recording time.",
    limits:
      "The kernel records the start as ticks after boot. The sampler adds the boot time, so the result is accurate to about a second and moves if the clock was stepped after boot.",
    related: ["procinfo", "session"],
    aliases: [],
    source: "`/proc/PID/stat`: field 22 (starttime)",
    sourceDetail:
      "Field 22 of `/proc/PID/stat` is the start time in clock ticks after boot. The sampler adds the wall-clock time of boot (CLOCK_REALTIME minus CLOCK_BOOTTIME). Check it yourself: `ps -o lstart= -p PID`.",
  },
  parentpid: {
    title: "Parent process",
    scope: "Target process · PID",
    meaning: "The process that started this one.",
    example: "",
    reading:
      "PID 1 means init or systemd started it, or it was adopted when its parent exited. A shell or supervisor PID shows who launched it.",
    limits:
      "None visible means the parent is outside the target's PID namespace, as in a container. The parent can change when the original parent exits; the value is the one read at the start.",
    related: ["procinfo", "target"],
    aliases: [],
    source: "`/proc/PID/stat`: field 4 (ppid)",
    sourceDetail:
      "Field 4 of `/proc/PID/stat`. Check it yourself: `ps -o ppid= -p PID`.",
  },
  owner: {
    title: "User & group",
    scope: "Target process · numeric IDs",
    meaning:
      "The numeric user and group the process runs as. Effective IDs are shown only when they differ, as for setuid and setgid programs.",
    example:
      "UID 1000 · GID 1000 is usually the first regular user on the host.",
    reading:
      "Compare it with the user that runs the sampler. The executable, working directory, and wait channels are readable only when the sampler runs as the target user.",
    limits:
      "Only numbers are shown; names live on the target host and the sampler does not look them up.",
    related: ["procinfo", "exe"],
    aliases: [],
    source: "`/proc/PID/status`: Uid, Gid",
    sourceDetail:
      'The first two numbers (real and effective) of the Uid and Gid lines of `/proc/PID/status`. Check it yourself: `grep -E "^(Uid|Gid)" /proc/PID/status`.',
  },
  allowedcpus: {
    title: "Allowed CPUs",
    scope: "Target process · CPU list",
    meaning:
      "The CPU cores the scheduler may run the process on, also called its affinity.",
    example: '"0-3,8" allows cores 0 to 3 and core 8.',
    reading:
      "Compare it with Core placement: threads can only appear on these cores. A short list can explain high CPU use or run delay on a few cores.",
    limits:
      "This is the mask of the main thread at the start. Other threads can have narrower masks, and a cgroup cpuset can narrow it further. A long list is cut.",
    related: ["cores", "delay"],
    aliases: [],
    source: "`/proc/PID/status`: Cpus_allowed_list",
    sourceDetail:
      "The Cpus_allowed_list line of `/proc/PID/status`. Check it yourself: `taskset -cp PID`.",
  },
  exitreason: {
    title: "Last process exit",
    scope: "Ended target process · kernel log and exit status",
    meaning:
      "Why the most recent target process ended: from the kernel log messages that name the process or one of its threads, else from its exit status.",
    example:
      '"Segmentation fault" means the kernel logged a memory fault. "Crashed: SIGABRT" means the process called abort(), which the kernel does not log.',
    reading:
      "Read the reason first, then the exit status and the kernel messages. The time is when the sampler noticed the exit, within one sample interval. The card is open while the ended process is the one the page shows. Once another process is the target, it folds to one line with the reason, the time and the number of exits since the collector started; open it for the details.",
    limits:
      'The kernel logs only the faults it handles and the out-of-memory killer, and reading the log needs kernel.dmesg_restrict = 0. The exit status names the signal or exit code without that, on Linux 6.15 and later, or when the sampler sees the process as a zombie. "No kernel crash message" means neither was found, so it does not prove the process did not crash. The card shows the latest exit since the collector started.',
    related: ["exitstatus", "exitmessages", "health"],
    aliases: ["Reason the process ended", "Earlier process exit"],
    source: "`/dev/kmsg`, then the exit status",
    sourceDetail:
      "The sampler reads new kernel log records from `/dev/kmsg` that name the target PID or one of its threads, such as a segfault or an OOM kill. If none names it, the reason comes from the exit status (see Exit status). Reading `/dev/kmsg` can need CAP_SYSLOG when kernel.dmesg_restrict = 1. Check it yourself: `dmesg | grep PID`.",
  },
  exitstatus: {
    title: "Exit status",
    scope: "Ended target process · waitpid status",
    meaning:
      "The signal or exit code that ended the process, as its parent would see it from waitpid().",
    example:
      '"SIGSEGV (signal 11), core dumped" is a crash. "exit code 3" means the process called exit(3).',
    reading:
      "A crash signal (SIGSEGV, SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGTRAP, SIGSYS) is a fault in the process. SIGKILL, SIGTERM and SIGINT usually come from another process. Exit code 0 is a normal exit.",
    limits:
      "The sampler is not the parent. It reads the status through a pidfd on Linux 6.15 and later, which needs no privileges, or from /proc while the process is a zombie. On older kernels the parent often reaps the process first, and the status is not available. SIGKILL from the out-of-memory killer looks like kill -9 unless the kernel log is readable.",
    related: ["exitreason", "exitmessages"],
    aliases: [],
    source: "pidfd (PIDFD_GET_INFO), or `/proc/PID/stat` field 52",
    sourceDetail:
      "The sampler opens a pidfd for the target with pidfd_open when it finds it. On Linux 6.15 and later, the PIDFD_GET_INFO ioctl returns the exit status after the parent reaps the process. While the process is a zombie, the sampler can also read field 52 (exit_code) of `/proc/PID/stat`.",
  },
  exitmessages: {
    title: "Kernel messages",
    scope: "Ended target process · up to six lines",
    meaning:
      "The newest kernel log lines that name the ended process or one of its threads, oldest first.",
    example:
      '"app[1240]: segfault at 0 ip … error 6 in app[…]" names thread 1240, the bad address, and the code that faulted.',
    reading:
      'Thread IDs in brackets match the TID column in the threads table. The address after "in" identifies the binary or library.',
    limits:
      "Only messages logged after the sampler found the process are read. Long lines are cut at 191 bytes. The out-of-memory task table is left out.",
    related: ["exitreason"],
    aliases: [],
    source: "`/dev/kmsg`",
    sourceDetail:
      "Kernel log records from `/dev/kmsg` that name the process or one of its thread IDs, logged after the sampler found the process. Check it yourself: `dmesg | grep PID`.",
  },
} as const satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof helpTopics;

export function isHelpTopicId(value: string): value is HelpTopicId {
  return Object.hasOwn(helpTopics, value);
}
