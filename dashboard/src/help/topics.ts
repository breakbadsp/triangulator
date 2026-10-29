export interface HelpTopic {
  title: string;
  scope: string;
  meaning: string;
  example: string;
  reading: string;
  limits: string;
  related: readonly HelpTopicId[];
  source: string;
  sourceDetail: string;
}

const topics = {
  page: {
    title: "How to read this page",
    scope: "Dashboard guide",
    meaning:
      "Read the scope, unit, time interval, and data status before interpreting a metric.",
    example: "",
    reading:
      "Read Assessment first, then the key measurements and charts. Open Timeline below the charts to inspect recordings. Use Theme in the header to select System, Light, or Dark. Pause over a label or value for 3 seconds. Focus a Help label for the same delay, or press Enter or Space on it for immediate help. Tap a Help label for immediate help. Open metric help, then select Open metric guide for an example, measurement limits, chart data, and related topics. Use Open page guide for every topic. Show help on hover controls pointer help; keyboard and touch help remain available. Select a ▸ heading to open or close its panel. The page remembers that choice in this browser. Monitor health, Address space & zoom, and Network stack drops open by themselves when the Assessment has a warning of their kind, until you choose.",
    limits:
      "A single metric does not establish a cause. Missing data is not zero.",
    related: ["cpu", "pressure", "health"],
    source: "`/proc` and `/sys/fs/cgroup` → sampler → collector → this page",
    sourceDetail:
      "The sampler runs on the target host as the target user. It reads `/proc` and `/sys/fs/cgroup` files and sends the raw counters over UDP. The collector turns counters into rates, stores history, and serves this page through `/api/…` endpoints. This page computes load, assessments, and findings. The Source section of each topic names its file.",
  },
  "target-attention": {
    title: "Other targets need attention",
    scope: "Targets outside this view",
    meaning: "Count of other targets that are absent, silent, or throttled.",
    example: "A count of 2 means two other targets need inspection.",
    reading: "Open the target selector and inspect their status.",
    limits: "This count does not identify the cause.",
    related: ["target-switch", "health", "sampler-budget"],
    source: "Collector target status and sampler rate",
    sourceDetail:
      "The page counts absent, silent, and throttled entries from `/api/targets`, excluding the selected target.",
  },
  "target-access": {
    title: "Limited access",
    scope: "Selected target",
    meaning: "The sampler cannot read all process files.",
    example:
      "CPU and thread states can remain available while I/O and memory maps are hidden.",
    reading:
      "Run the sampler as the target user for full access when process permissions permit it.",
    limits:
      "Access can also be limited for a process that disables inspection.",
    related: ["wchan", "memmap"],
    source: "Sampler access checks for `/proc/PID/io` and `/proc/PID/maps`",
    sourceDetail:
      "The sampler reports limited access when these files cannot be opened. Permission changes are checked with each announcement.",
  },
  "sampler-budget": {
    title: "Sampler throttled",
    scope: "Sampler host · all targets",
    meaning:
      "The sampler reduced its shared rate because its CPU use exceeded the configured budget.",
    example:
      "A 1% budget permits about 0.01 seconds of sampler CPU time per elapsed second.",
    reading:
      "The badge shows the effective rate, measured CPU use, and budget. Low CPU use permits gradual rate recovery.",
    limits:
      "The minimum is 0.2 Hz. CPU use can still exceed the budget at that rate.",
    related: ["health", "target-switch"],
    source: "`CLOCK_THREAD_CPUTIME_ID` and monotonic elapsed time",
    sourceDetail:
      "The sampler measures CPU time for all targets and sends raw counters in TTGT. The collector computes the percentage. The sampler lowers the rate after about five seconds above its budget.",
  },
  assesshistory: {
    title: "Past assessments",
    scope: "Recordings · checked period",
    meaning:
      "What the Assessment found in the past. The dashboard reads recorded views of the process and applies the same fixed rules as the Assessment card to each one.",
    example:
      "When the page opens, up to 120 recordings of the last 15 minutes are checked, one every ~8 s. “worker-3 is saturating a core” seen from 14:02:10 to 14:05:40 in 25 checked recordings is one row, and one red mark on the timeline.",
    reading:
      "Rows are newest first. Each shows the worst level it reached, when it was first and last seen, its type, and how many checked recordings had it. Select a row to move the whole dashboard to its worst moment: the Assessment card then shows the same finding and the row shows its detail. Scroll to the end of the list, select Load earlier, or release the timeline at its left end to check an earlier period; each is twice as long as the one before, up to 6 hours. While live, newer recordings are added every 15 seconds.",
    limits:
      "Each period checks up to 120 recordings, so older periods are checked more coarsely: a problem that starts and ends between two of them is not listed, and its first and last times are accurate only to the step. Recording gaps end a row. Each recording is judged on its own: rules that need trends kept in a live tab (thread growth, thread churn, long futex waits) and the watch rule with no thread do not run. Resident memory growth uses the stored resource samples before each recording, combined into coarser steps for long periods. The main-stack rule runs only while the recording’s memory map is still the newest one. Nothing is stored: a reload checks again. Every checked recording is downloaded, about 330 KB each with 1,000 threads.",
    related: ["timeline", "assessment", "historyfilters"],
    source: "Recordings from `/api/replay`, checked in this page",
    sourceDetail:
      "This page loads recorded views from the collector through `/api/replay` and applies the Assessment rules to each one.",
  },
  historyfilters: {
    title: "Past assessment filters",
    scope: "Rows already checked",
    meaning:
      "Show only past findings of the chosen severities and type, in the list and as timeline marks. The type is the area the rule looks at.",
    example:
      "Severity Critical and Serious with type Watched threads lists only watched threads that stopped waking or kept a core busy.",
    reading:
      "Monitoring: sampler, target and packet loss. Threads & CPU: CPU, run delay, kernel waits, faults, stopped and unreadable threads, lock hints. Watched threads: the watch rules. Resources & network: pressure, limits, descriptors and sockets. Memory: memory-map findings. A row keeps the worst severity it reached. Filters apply at once and read nothing new.",
    limits:
      "Info is off at first because info findings are notes, not problems. Filters only hide rows; the status line counts all of them.",
    related: ["assesshistory", "assessment"],
    source: "Past assessments already checked in this page",
    sourceDetail: "Filters hide rows and marks. They send no request.",
  },
  timeline: {
    title: "Timeline and recorded views",
    scope: "Selected target · collector recordings",
    meaning:
      "Previous from Live opens the newest recording. Previous and Next select actual recordings. Drag to preview a time, then release to select the recording at or before it. The last selectable step returns to Live. The bar runs from the oldest time the past-assessment list has checked (at least the last 15 minutes) on the left to now on the right; coloured marks above it show when past findings were present.",
    example:
      "Select Previous to inspect the latest recorded process state. Select Live or Back to live to return to the retained live or final view.",
    reading:
      "Recorded values use the recording time and process identity. State and CPU rates come from the snapshot. Live averages, live trend charts, and Settings edits are unavailable. Thread history ends at the recording time. A compatible cached memory layout is labelled latest and is not a recorded layout. Release the handle at the left end to also check an earlier period, which stretches the bar further back.",
    limits:
      "A gap, missing recording, invalid reply, or read error keeps the last successful view. The collector clock can be ahead of this browser. Recording can be disabled. This Timeline does not play automatically.",
    related: ["assesshistory", "exited", "history", "memmap", "collsettings"],
    source: "Collector /api/replay snapshots and /api/resources rollups",
    sourceDetail:
      "recorded_at fixes the display clock. Snapshot rates cover the preceding sampling interval. Resource reads end at that time. Recordings never enter this tab's live trends or storage.",
  },
  exited: {
    title: "Final process view",
    scope: "Selected target · last populated process session",
    meaning:
      "When the sampler confirms that the target is absent, this tab keeps its last populated view and trends. A restart does not replace them. Show live dismisses the final view.",
    example:
      "Inspect the final threads after a process exits. Select Show live to see the replacement process.",
    reading:
      "The stopped time fixes every panel's clock. A late exit report is shown only when its session and PID match. Settings continues to edit the current collector and counts its current threads. During recorded inspection, Show live dismisses the final view and leaves the recording open.",
    limits:
      "A new empty session has a ten-second settling period. A fresh tab can use the collector's last-target view but has no earlier live CPU samples. If tab storage is full, the banner warns that reload loses the final view.",
    related: ["timeline", "exitreason", "health", "collsettings"],
    source: "Sampler absence and collector /api/last-target, /api/live",
    sourceDetail:
      "This tab saves the final view, compatible memory layout, and matching exit in target-scoped session storage. Later resource reads end at the stopped time; layout refresh stops.",
  },
  "target-pid": {
    title: "Matching processes",
    scope: "Add target · processes with the entered name",
    meaning:
      "When the process name matches more than one running process, the sampler cannot tell which one to monitor. This list shows each one with its PID, user, start time, and command line.",
    example:
      "Two processes named worker: PID 4100 · app · started 3 h ago · worker --queue orders, and PID 4377 · app · started 2 min ago · worker --queue billing. Select the first to monitor the orders worker.",
    reading:
      "A choice fills in its PID. Then select Add target. To monitor by name instead, stop the extra processes, or give them different names.",
    limits:
      "A PID does not follow a restart: after the process restarts, the target is absent until you add the new PID. The list shows at most 20 processes, and it says when more match.",
    related: ["manage-targets", "target-id"],
    source:
      "Local control helper: `/proc/PID/comm`, `cmdline`, `stat`, and the owner of `/proc/PID`",
    sourceDetail:
      "The helper finds every process whose name equals the entered name, as the sampler does, and returns each PID with its user, start time (`/proc/PID/stat` field 22 and `btime`), and command line.",
  },
  "fleet-waiting": {
    title: "Waiting for a process",
    scope: "Configured exact name",
    meaning:
      "The name is configured but no running process is admitted for it.",
    example: "orders-api appears when a process with that Linux name starts.",
    reading:
      "Discovery continues without a reload. Each instance gets its own tile.",
    limits:
      "Linux keeps 15 bytes of the name. A stale tile instead means that samples stopped arriving.",
    related: ["manage-targets", "fleet-capacity"],
    source: "Sampler discovery and absent heartbeat",
    sourceDetail: "A waiting slot sends an absent heartbeat with PID zero.",
  },
  "fleet-capacity": {
    title: "Target capacity",
    scope: "Sampler and collector limits",
    meaning:
      "Some matching processes cannot be monitored because a target limit is reached.",
    example:
      "3 excluded matches means three processes found by the last completed scan had no sampler slot.",
    reading:
      "Increase max_targets on the monitored host or narrow the rules. Check the collector limit too.",
    limits:
      "Existing instances stay admitted. The sampler count is capped at 255 and can lag by one scan pass. Collector capacity_drops counts rejected packets, not unique processes.",
    related: ["fleet-waiting", "manage-targets"],
    source: "TTGT excluded count and collector capacity_drops",
    sourceDetail:
      "Both programs preallocate target slots. The sampler reports excluded matches after each completed bounded pass.",
  },
  "manage-targets": {
    title: "Manage targets",
    scope: "Local testing · every viewer",
    meaning:
      "The sampler.toml file on each monitored host owns production selection. Dashboard Add and Remove are for testing with a verified local sampler.",
    example:
      "With process_names, enter orders-api once to monitor all its instances. No target ID is needed.",
    reading:
      "Each change needs confirmation and persists in the local configuration. Remove deletes the exact-name rule and stops every instance of that name. A process that a pattern selects, or that was renamed after it was admitted, cannot be removed here; edit sampler.toml on its host.",
    limits:
      "Remote samplers cannot be changed here. A non-loopback browser client also needs network_target_control = true on the collector. This testing option is off by default and has no authentication. Legacy target tables require at least one target.",
    related: ["target-id", "target-switch", "fleet-capacity"],
    source: "Local control helper, kernel packet source, and sampler.toml",
    sourceDetail:
      "The helper verifies the runtime sampler executable, user, and loopback collector endpoint. The API checks the selected target's kernel source address. Host names do not grant access. The sampler validates a full file before reload.",
  },
  "target-id": {
    title: "Target ID",
    scope: "Sampler configuration",
    meaning: "A stable name for one monitored target.",
    example: "orders remains the same ID when orders-api restarts.",
    reading:
      "Use 1 to 31 letters, digits, dots, underscores, or hyphens. Each ID must be unique on its host.",
    limits:
      "An ID is not a process selector. Set a process name or PID as well.",
    related: ["manage-targets", "target-switch"],
    source: "`[[target]] id` in sampler.toml",
    sourceDetail:
      "The sampler sends this stable ID in TTGT. A target key combines the sampler host name and this ID.",
  },
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
    source: "Collector: datagrams received from the sampler",
    sourceDetail:
      "The collector counts the UDP datagrams it receives from the sampler: when the last one arrived, their session, sequence gaps, and rejected packets. It serves the result in `/api/live`. Nothing here is read from the target process.",
  },
  interval: {
    title: "Sample interval",
    scope: "Sampler · milliseconds",
    meaning: "The configured time between thread samples.",
    example: "200 ms corresponds to five samples per second.",
    reading: "Resource samples have a separate reporting interval.",
    limits:
      "Short events between samples can be missed. A shorter interval increases sampling overhead.",
    related: ["health", "history"],
    source: "`rate_hz` in sampler.toml",
    sourceDetail:
      "The sampler sends its interval in every datagram. It comes from `rate_hz` in sampler.toml, which `scripts/set-rate.sh` changes (0.2–10 Hz, 5 Hz by default).",
  },
  loss: {
    title: "Packet loss (1 min)",
    scope: "Sampler link · preceding minute",
    meaning:
      "The reported share of missing sampler packets in the last minute.",
    example: "",
    reading:
      "Compare loss with sample age and incomplete data before drawing conclusions.",
    limits:
      "Packet loss in the monitor is different from application network drops.",
    related: ["health", "netdrops"],
    source: "Collector: gaps in the numbered sampler datagrams",
    sourceDetail:
      "The sampler numbers each sample and the datagrams it is split into. Over the last minute, the collector counts the datagrams that never arrived, including whole skipped samples, and divides by the number expected.",
  },
  session: {
    title: "Session",
    scope: "Sampler session",
    meaning:
      "A session separates one sampler run or sampling configuration from another.",
    example: "",
    reading:
      "Use the session and thread generation when comparing observations across restarts.",
    limits:
      "A new session does not necessarily mean that the target process restarted.",
    related: ["thread", "health"],
    source: "Random ID chosen by the sampler",
    sourceDetail:
      "The sampler picks a random session ID when it starts, reloads its configuration, or finds a new target process, and puts it in every datagram. The collector stores history under that ID.",
  },
  packetcounts: {
    title: "Bad · duplicate · late",
    scope: "Sampler packets · counters",
    meaning:
      "Packets rejected as invalid, received more than once, or received too late for normal assembly.",
    example: "",
    reading: "Compare these counters with loss and sample age.",
    limits:
      "These are monitor transport counters, not application socket errors.",
    related: ["loss", "health"],
    source: "Collector packet counters",
    sourceDetail:
      "The collector counts datagrams it could not decode (bad), received twice (duplicate), or that arrived after their sample was assembled (late).",
  },
  rawsamples: {
    title: "Raw samples held",
    scope: "Collector · observation count",
    meaning:
      "The number of raw thread observations retained in the collector buffer.",
    example: "",
    reading:
      "Use this count when checking collector retention and buffer behavior.",
    limits: "This is not a count of active threads or stored history buckets.",
    related: ["health", "history"],
    source: "Collector memory",
    sourceDetail:
      "The number of raw thread samples in the in-memory buffer of the collector, from `/api/live`.",
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
      "Tiles do not run trend rules or memory-map layout rules. Each refresh returns the latest live view of every target in one response, so a large number of targets makes that response larger than one dashboard needs.",
    related: ["fleet-tile", "target-switch", "assessment"],
    source: "Collector: `/api/fleet`",
    sourceDetail:
      "The page makes one `/api/fleet` request every 5 seconds. It returns the target list and the latest live view of each target from one publication.",
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
    source: "Thread samples from `/proc/PID/task/TID/`, summed",
    sourceDetail:
      "The tiles sum the values of the threads: CPU and faults from `stat`, run delay and switches from `schedstat`, read and write bytes from `io`, and states from `stat` and `wchan`.",
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
    reading: "Use the resource Disk I/O panel for block-layer activity.",
    limits:
      "These counters do not cover every receive API and are not a measure of bytes transferred by the disk device.",
    related: ["disk"],
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
    source: "`/proc/PID/status`: VmSize, VmPeak",
    sourceDetail:
      'With each memory sample, the sampler reads VmSize and VmPeak from `/proc/PID/status`. Check it yourself: `grep -E "VmSize|VmPeak" /proc/PID/status`.',
  },
  collsettings: {
    title: "Collector settings",
    scope: "Collector · saved on the collector host",
    meaning:
      "Settings that change how the collector behaves, edited here instead of in files on the collector host. Today only the watched-thread rules are editable.",
    example: "",
    reading:
      "Each card applies its change at once and says where the value is saved. Settings that need a collector restart will say so beside the control.",
    limits:
      "The tab is read-only while you inspect a recorded moment, and when the collector is a build without these controls. Other collector settings are still edited in collector.toml.",
    related: ["watches", "timeline"],
    source: "Collector: `/api/watches`",
    sourceDetail:
      "This tab reads and writes the collector settings through `/api/watches`. Rules saved here apply to the selected target. They use `data_dir/watch-rules/<hex-key>.json`; the default target that keeps `data_dir/replay` keeps `data_dir/watch-rules.json`.",
  },
  watches: {
    title: "Watch rules",
    scope: "Collector · thread name prefixes",
    meaning:
      "Rules that say threads whose name starts with a prefix should wake at least every N milliseconds, as workers that wait with a timeout do. The Assessment flags a matching thread that stops waking (a possible deadlock, or a wait with no timeout) or keeps a core busy (a possible infinite loop).",
    example:
      '"worker-" every 500 ms watches worker-1, worker-2 and so on. A thread that has not run for much longer than 500 ms is then reported.',
    reading:
      'Add one rule per group of threads that should keep waking. When several prefixes match, the longest one is used, so "worker-" and "worker-io" can have different intervals. Check Matching threads now before you save.',
    limits:
      "The collector only reports when each thread last ran. A thread with a long wait by design, or a name that no rule matches, is not watched. A rule does not start or stop anything.",
    related: ["assessment", "thread", "states"],
    source: "[[watch]] in collector.toml, or `data_dir/watch-rules.json`",
    sourceDetail:
      "The collector reads the [[watch]] tables of collector.toml when it starts. Rules saved from this page replace them for the selected target until Reset. Target files are in `data_dir/watch-rules/`; the default target that keeps `data_dir/replay` keeps `data_dir/watch-rules.json`. This page reads the rules in force from `/api/watches`.",
  },
  watchsource: {
    title: "Where the watch rules come from",
    scope: "Collector · rules in force",
    meaning:
      "Whether the rules in force come from the [[watch]] tables in collector.toml or were saved from this dashboard. Rules saved here replace the config file rules completely, even an empty list, until you reset.",
    example: "",
    reading:
      '"From the config file" means nothing was saved here. After Reset to config file the collector uses the [[watch]] rules again. A warning means the saved rules could not be read, so the config file rules are in force.',
    limits:
      "Editing collector.toml has no effect on watch rules while dashboard rules are saved. The collector reads the config file only at startup.",
    related: ["watches", "watchreset"],
    source: "[[watch]] in collector.toml, or `data_dir/watch-rules.json`",
    sourceDetail:
      "The collector reports which file the rules in force came from through `/api/watches`.",
  },
  watchprefix: {
    title: "Thread name prefix",
    scope: "One rule · UTF-8 bytes",
    meaning:
      "The start of the thread names the rule applies to. A rule matches every thread whose name begins with these characters, with the same upper and lower case.",
    example:
      '"worker-" matches worker-1 and worker-io but not Worker-1 or my-worker-1.',
    reading:
      "Use 1 to 15 bytes. Linux thread names are at most 15 bytes, so a longer prefix could never match. Each prefix may appear once. The count next to it shows at once whether the prefix is right.",
    limits:
      "Spaces count, so a trailing space must match the name. Characters outside ASCII use more than one byte. The tab checks the rules again on save, and the collector has the final say.",
    related: ["watchmatch", "watchwake"],
    source: "",
    sourceDetail: "",
  },
  watchwake: {
    title: "Wakes at least every (ms)",
    scope: "One rule · milliseconds",
    meaning:
      "The longest time a matching thread may go without running before it counts as stuck. Workers that wait with a timeout wake at least this often.",
    example: "500 means the thread should run at least twice a second.",
    reading:
      "Use a whole number from 10 to 3,600,000 (one hour). Choose a value above the thread's wait timeout, plus some margin for a busy host. A value close to the sample interval is noisy.",
    limits:
      "A thread that waits without a timeout will never meet a small value. That is what the rule is meant to show, but it can also be a thread that is idle by design.",
    related: ["watches", "interval"],
    source: "",
    sourceDetail: "",
  },
  watchmatch: {
    title: "Matching threads now",
    scope: "Live threads · your edited rules",
    meaning:
      "How many threads of the monitored process have a name that starts with this prefix right now, counting each thread under the longest matching prefix, as the collector does. A few names follow the count.",
    example:
      '"3 · worker-1, worker-2, worker-3" means three threads would use this rule.',
    reading:
      "It updates while you type and as threads start and stop, before anything is saved. 0 usually means a typo, wrong case, or threads that do not exist yet. A note shows threads that match this prefix but use a longer one.",
    limits:
      "Threads are counted at the latest sample. While you inspect a recorded moment or the target is absent, there are no live threads to count. In the final view of an ended target, the count follows the threads the collector reports now, such as those of a restarted target. Names are cut at 15 bytes by Linux.",
    related: ["watchprefix", "thread"],
    source: "Thread names from the latest live update",
    sourceDetail:
      "This page counts the thread names (field 2 of `/proc/PID/task/TID/stat`) in the latest live update that start with each prefix.",
  },
  watchremove: {
    title: "Remove a watch rule",
    scope: "One rule",
    meaning:
      "Takes this rule out of the list you are editing. Nothing changes on the collector until you select Save.",
    example: "",
    reading:
      "Remove a rule you no longer need, then check the other counts. Use Discard edits to bring back the saved list.",
    limits:
      "Threads that matched the rule are then not watched, unless a shorter prefix also matches them.",
    related: ["watchsave"],
    source: "",
    sourceDetail: "",
  },
  watchadd: {
    title: "Add watch rule",
    scope: "Rules you are editing",
    meaning: "Adds an empty row for a new prefix and interval.",
    example: "",
    reading:
      "Fill in the prefix and interval, then check Matching threads now before you save. The collector accepts up to the limit shown beside the button.",
    limits: "The new rule exists only in this page until you select Save.",
    related: ["watchprefix", "watchsave"],
    source: "",
    sourceDetail: "",
  },
  watchsave: {
    title: "Save watch rules",
    scope: "Collector · whole list at once",
    meaning:
      "Applies the whole list in the table to the collector at once and saves it on the collector host, replacing the config file rules. Save is off while any field has a problem, or when nothing has changed and the last save was confirmed.",
    example: "",
    reading:
      "Fix each marked field, then select Save. The message below the button tells whether the collector accepted the list; if it refuses, its message is shown unchanged and nothing changes. Discard edits restores the list now in force.",
    limits:
      "These rules are shared by all viewers. If another user changes them, your save is refused and your draft stays in the table. Select Reload current rules to discard the draft and review the saved list. Unsaved edits are lost when you reload, leave the page, or reset. If the collector reports that it applied the rules but could not confirm that they were written to disk, select Save again to retry. The retry is refused if another user changed the rules.",
    related: ["watchsource", "watchreset"],
    source: "",
    sourceDetail: "",
  },
  watchreload: {
    title: "Reload current watch rules",
    scope: "Shared collector settings",
    meaning:
      "Loads the current saved rules after another user changed them, or after the collector restarted. Your save or reset was refused so it could not overwrite that change.",
    example: "",
    reading:
      "Copy any edits you want to keep. Select Reload current rules, confirm that the draft can be discarded, then review and edit the current list.",
    limits:
      "Your draft stays in the table if you cancel or the read fails. A successful reload replaces it.",
    related: ["watchsave", "watchreset"],
    source: "",
    sourceDetail: "",
  },
  watchreset: {
    title: "Reset watch rules",
    scope: "Collector · rules saved from the dashboard",
    meaning:
      "Deletes the rules saved from this dashboard, and returns to the [[watch]] rules in collector.toml. You are asked to confirm because this discards the dashboard rules and any unsaved edits.",
    example: "",
    reading:
      "Use it when you want the config file to be the single source again. It is also the way to clear a saved file that the collector could not read.",
    limits:
      "It is off when the config file rules are already in force, unless the collector could not confirm the last reset on disk; then select it again to retry. It cannot restore the rules you discard. If another user changed the rules, reset is refused until you reload the current rules.",
    related: ["watchsource", "watchsave"],
    source: "",
    sourceDetail: "",
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
    source: "`/dev/kmsg`",
    sourceDetail:
      "Kernel log records from `/dev/kmsg` that name the process or one of its thread IDs, logged after the sampler found the process. Check it yourself: `dmesg | grep PID`.",
  },
  cpu: {
    title: "CPU",
    scope: "One core · percentage",
    meaning: "CPU time used, as a percentage of one CPU core.",
    example: "50% means 0.5 seconds of CPU time per elapsed second.",
    reading:
      "Compare CPU use with run delay. Process CPU sums all reported threads and can exceed 100%.",
    limits:
      "A high value can be normal for a busy worker. CPU use alone does not establish a problem.",
    related: ["delay", "pressure", "cores"],
    source: "`/proc/PID/task/TID/stat`: utime + stime",
    sourceDetail:
      "Each sample, the sampler reads `/proc/PID/task/TID/stat` for every thread. Fields 14 (utime) and 15 (stime) are the CPU time the thread used in user and kernel mode, in clock ticks (usually 100 per second). The collector divides the change between two samples by the time between them. Process CPU sums the threads. `top -H -p PID` reads the same counters.",
  },
  delay: {
    title: "Run delay",
    scope: "Elapsed time · percentage",
    meaning: "Time a thread was ready to run but waited for a CPU.",
    example: "12% means 120 ms waiting per elapsed second.",
    reading:
      "Persistent delay can indicate competition for CPU time. Compare CPU use, cgroup CPU pressure, and quota throttling.",
    limits:
      "Sleep and futex wait are separate measurements. Run delay alone does not identify a cause.",
    related: ["cpu", "pressure", "throttle"],
    source: "`/proc/PID/task/TID/schedstat`: second number",
    sourceDetail:
      "Each sample, the sampler reads `/proc/PID/task/TID/schedstat`. Its second number is the total time, in nanoseconds, that the thread was ready to run but waited for a CPU. The collector divides the change between two samples by the time between them. With `status_fallback = true` in sampler.toml, the sampler reads `status` instead, and run delay is not available. Check it yourself: `cat /proc/PID/task/TID/schedstat`.",
  },
  states: {
    title: "Thread states",
    scope: "Sampled scheduler state and wait channel",
    meaning:
      "A sampled classification of what a thread is doing or waiting for.",
    example:
      "Futex wait can indicate a lock, condition variable, or timed idle wait.",
    reading:
      "Running is blue and Sleep is green. State colors match across the map, state mix, charts, and wait-channel bars. Other and No access have separate gray colors. Read the state together with CPU use, run delay, and the kernel wait channel. Select a state to filter the table.",
    limits:
      "Samples can miss brief transitions. A wait state does not establish that the application is unhealthy.",
    related: ["futex", "kernel", "mix"],
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "Field 3 of `/proc/PID/task/TID/stat` is the scheduler state letter. For a sleeping thread, `/proc/PID/task/TID/wchan` names the kernel function it waits in. The collector maps R to Running, D to Kernel wait, and T or t to Stopped. Otherwise it matches the wait channel: futex; epoll, poll, or select; socket functions; pipe or eventfd; and nanosleep. An empty wait channel is No access. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  mix: {
    title: "State mix",
    scope: "Share of observed samples",
    meaning: "The proportion of samples classified into each thread state.",
    example: "Six running samples out of ten gives a 60% running sample share.",
    reading:
      "Use the displayed interval and sample count when comparing the colored bands.",
    limits:
      "Sample share is not an exact trace of time spent in each state. Missing samples reduce coverage.",
    related: ["states", "history"],
    source: "Collector: counts of classified thread samples",
    sourceDetail:
      "The collector classifies every thread sample as Thread states describes (from `stat` field 3 and `wchan`) and counts the samples in each state over the window.",
  },
  wchan: {
    title: "Wait channel",
    scope: "Thread · kernel function",
    meaning: "The kernel function in which a sampled thread is waiting.",
    example: "",
    reading:
      "Bars use the same state colors as the thread map and state mix. A channel with multiple states and the combined remaining channels use neutral gray. Select a wait-channel bar or filter to inspect the matching threads.",
    limits:
      "Kernel function names depend on the kernel. A name alone does not identify an application call site.",
    related: ["states", "futex"],
    source: "`/proc/PID/task/TID/wchan`",
    sourceDetail:
      "Each sample, the sampler reads `/proc/PID/task/TID/wchan`: the kernel function a sleeping thread waits in. Compiler suffixes such as .constprop.0 are removed. The kernel shows 0 for a running thread and to a reader without access to the target. Check it yourself: `cat /proc/PID/task/TID/wchan`.",
  },
  map: {
    title: "Thread map",
    scope: "One tile per reported thread",
    meaning:
      "Tiles group threads by current state. Each visible number is CPU use relative to one core.",
    example:
      "A faded tile is idle; its color still represents its sampled state.",
    reading:
      "Now uses the preceding ~10 seconds. Other windows average CPU observations retained in this tab. Select a tile for thread details.",
    limits:
      "Color represents the current sampled state even when the CPU number is an average. Short observation history limits the average.",
    related: ["cpu", "states", "active"],
    source: "Thread CPU and state from `/proc/PID/task/TID/stat` and `wchan`",
    sourceDetail:
      "Each tile uses the CPU of the thread from `/proc/PID/task/TID/stat` (utime + stime) and its classified state (see Thread states). Windows longer than Now average the CPU values this tab received.",
  },
  families: {
    title: "Where the CPU goes",
    scope: "Process · CPU grouped by thread",
    meaning:
      "CPU use grouped by name family, configured group, or individual thread.",
    example: "",
    reading:
      "Name family removes the numeric suffix. Config group uses the collector configuration. Select a bar to filter where available.",
    limits:
      "Similar names do not prove that threads do the same work. Percentages of process CPU differ from percentages of one core.",
    related: ["cpu", "group"],
    source:
      "Thread names from `/proc/PID/task/TID/stat`; groups from collector.toml",
    sourceDetail:
      "Name family removes the trailing number from the thread name (field 2 of `/proc/PID/task/TID/stat`, the same as `comm`). Config group uses the [[group]] prefixes in collector.toml. The CPU of each thread comes from utime + stime in `stat`.",
  },
  cores: {
    title: "Core placement",
    scope: "Last observed CPU core",
    meaning:
      "Thread CPU use grouped by the core on which each thread last ran.",
    example: "",
    reading:
      "Uneven bars can indicate affinity or pinning. Compare thread counts with CPU use.",
    limits:
      "A thread can migrate between samples. These bars are not exact per-core utilization measurements.",
    related: ["cpu", "thread"],
    source: "`/proc/PID/task/TID/stat`: field 39 (processor)",
    sourceDetail:
      "Each sample, the sampler reads field 39 of `/proc/PID/task/TID/stat`, the CPU on which the thread last ran. CPU use comes from utime + stime in the same file. Check it yourself: `ps -L -o tid,psr,comm -p PID`.",
  },
  group: {
    title: "Group",
    scope: "Collector configuration",
    meaning: "The configured group assigned to a thread.",
    example: "",
    reading: "Use the group filter to compare a known set of worker threads.",
    limits:
      "A configured group is different from a name family or a Linux cgroup.",
    related: ["families", "pressure"],
    source: "[[group]] prefixes in collector.toml",
    sourceDetail:
      "The collector assigns each thread to the first [[group]] in collector.toml whose prefix starts the thread name, or to ungrouped. The thread name is field 2 of `/proc/PID/task/TID/stat`.",
  },
  history: {
    title: "History",
    scope: "Thread · stored five-second summaries",
    meaning:
      "Stored summaries show CPU, run delay, state samples, and I/O for the selected thread generation.",
    example: "",
    reading:
      "Choose a range or From/To times. Recent live CPU uses observations from this tab; stored history comes from the collector.",
    limits:
      "Summary buckets are not exact process snapshots. Missing buckets and missing values mean unknown, not zero.",
    related: ["timeline", "mix", "samples"],
    source: "Collector five-second summaries, through `/api/history`",
    sourceDetail:
      "The collector combines the samples of each thread into five-second rows and stores them in SQLite day files under `data_dir`. The drawer loads them with `/api/history`. Recent live CPU comes from the updates this tab received.",
  },
  samples: {
    title: "Samples",
    scope: "Count per stored bucket",
    meaning: "The number of observations included in a stored summary bucket.",
    example: "",
    reading:
      "Use the count to assess how much data supports the state mix and rates.",
    limits: "A partial bucket or packet loss can reduce the count.",
    related: ["history", "loss"],
    source: "Collector: thread samples in each stored row",
    sourceDetail:
      "The number of thread samples the collector combined into the five-second row.",
  },
  running: {
    title: "Running",
    scope: "Thread · sampled state",
    meaning: "The scheduler reports the thread running or ready to run.",
    example: "",
    reading: "Compare the wait channel and recent thread history.",
    limits:
      "This state does not prove that it occupied a CPU for the full interval.",
    related: ["states", "wchan"],
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Running when field 3 of `stat` is R. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  futex: {
    title: "Futex wait",
    scope: "Thread · sampled state",
    meaning:
      "The kernel wait channel indicates a futex wait, often used for synchronization.",
    example: "",
    reading: "Compare the wait channel and recent thread history.",
    limits:
      "A lock, condition variable, or timed idle wait can use futex. This sample cannot distinguish them.",
    related: ["states", "wchan"],
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Futex wait when the wait channel contains futex. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  poll: {
    title: "Poll / epoll",
    scope: "Thread · sampled state",
    meaning: "The thread is waiting in a poll-style event loop.",
    example: "",
    reading: "Compare the wait channel and recent thread history.",
    limits: "Waiting for events can be normal. Check whether work is expected.",
    related: ["states", "wchan"],
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Poll / epoll when the wait channel contains epoll, poll, or select. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  socket: {
    title: "Socket wait",
    scope: "Thread · sampled state",
    meaning: "The sampled wait channel indicates a socket-related wait.",
    example: "",
    reading: "Compare the wait channel and recent thread history.",
    limits: "The state does not identify which peer or socket caused the wait.",
    related: ["states", "wchan"],
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Socket wait when the wait channel contains skb, sk_wait, sock, unix_stream, inet_csk, tcp_, or udp_. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  pipe: {
    title: "Pipe / eventfd",
    scope: "Thread · sampled state",
    meaning: "The thread is waiting on a pipe or event notification.",
    example: "",
    reading: "Compare the wait channel and recent thread history.",
    limits: "This state can be normal coordination between threads.",
    related: ["states", "wchan"],
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Pipe / eventfd when the wait channel contains pipe or eventfd. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  sleep: {
    title: "Sleep",
    scope: "Thread · sampled state",
    meaning: "The sampled wait channel indicates a sleep or timer wait.",
    example: "",
    reading: "Compare the wait channel and recent thread history.",
    limits:
      "A sleeping thread is not necessarily blocked by a resource problem.",
    related: ["states", "wchan"],
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Sleep when the wait channel contains nanosleep. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  stopped: {
    title: "Stopped",
    scope: "Thread · sampled state",
    meaning: "The thread is stopped, for example by a signal or debugger.",
    example: "",
    reading: "Compare the wait channel and recent thread history.",
    limits: "Check the expected process state before treating this as a fault.",
    related: ["states", "wchan"],
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Stopped when field 3 of `stat` is T or t. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  other: {
    title: "Other",
    scope: "Thread · sampled state",
    meaning: "The sample does not match a more specific state category.",
    example: "",
    reading: "Compare the wait channel and recent thread history.",
    limits: "Do not interpret this category as running or as an error.",
    related: ["states", "wchan"],
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows Other when the wait channel matches no other state. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  no_access: {
    title: "No access",
    scope: "Thread · sampled state",
    meaning:
      "The sampler could not read enough information to classify this thread.",
    example: "",
    reading: "Compare the wait channel and recent thread history.",
    limits:
      "Unavailable observations are not zero activity. Check access and monitor health.",
    related: ["states", "wchan"],
    source: "`/proc/PID/task/TID/stat` field 3, and `wchan`",
    sourceDetail:
      "The collector shows No access when the state letter is not R, D, T, or t and the wait channel is empty: it read 0 or could not be read. Each sample, the sampler reads `/proc/PID/task/TID/stat` and `/proc/PID/task/TID/wchan` for every thread. Check it yourself: `ps -L -o tid,stat,wchan:32,comm -p PID`.",
  },
  pressure: {
    title: "Pressure stalls (PSI)",
    scope: "Displayed host or cgroup · time share",
    meaning:
      "Pressure stall information measures time tasks waited for CPU, memory, or I/O.",
    example:
      "Some: at least one task waited. Full: all non-idle tasks waited at once.",
    reading:
      "Table values cover the latest resource interval; chart points show interval peaks. The first sample can use the kernel avg10 average. Assessment checks CPU some at 20%, memory some at 5% or full at 2%, and I/O some at 10% or full at 5%.",
    limits:
      "The target cgroup can contain other processes. Host values cover the entire host. Host CPU full is not a useful stall measure.",
    related: ["throttle", "rss", "disk"],
    source: "`/proc/pressure/*` and `/sys/fs/cgroup/CGROUP/*.pressure`",
    sourceDetail:
      "Host values come from `/proc/pressure/cpu`, `memory`, and `io`. Cgroup values come from `cpu.pressure`, `memory.pressure`, and `io.pressure` in the target cgroup directory under `/sys/fs/cgroup`, found from `/proc/PID/cgroup`. Interval values use the change of the cumulative total= stall time; the first sample uses avg10. Check it yourself: `cat /proc/pressure/cpu`.",
  },
  disk: {
    title: "Disk I/O",
    scope: "Process · block-layer bytes per second",
    meaning:
      "Storage traffic attributed to the process by the block-layer counters.",
    example: "",
    reading:
      "Compare read/write rates with I/O pressure and major page faults.",
    limits:
      "Caching can make storage traffic differ from application read/write traffic.",
    related: ["sysio", "pressure", "faults"],
    source: "`/proc/PID/io`: read_bytes, write_bytes",
    sourceDetail:
      "With each resource sample, the sampler reads read_bytes and write_bytes from `/proc/PID/io`: bytes the process caused the block layer to read or write, including threads that have ended. The collector divides the change by the interval. The file is readable only when the sampler runs as the target user. Check it yourself: `cat /proc/PID/io`.",
  },
  fds: {
    title: "Open files",
    scope: "Process · descriptors and soft limit",
    meaning:
      "The number of open file descriptors relative to the process soft descriptor limit.",
    example: "Sockets also consume file descriptors.",
    reading:
      "At the soft limit, open(), accept(), and socket() can fail with EMFILE. Compare growth with expected workload.",
    limits:
      "The hard limit restricts changes to the soft limit. An unknown limit is not unlimited.",
    related: ["limits"],
    source: "`/proc/PID/fd` count; `/proc/PID/limits`: Max open files",
    sourceDetail:
      "With each resource sample, the sampler counts the entries of `/proc/PID/fd` and reads the Max open files line (soft and hard) of `/proc/PID/limits`. Check it yourself: `ls /proc/PID/fd | wc -l`.",
  },
  limits: {
    title: "Limits & headroom",
    scope: "Process, cgroup, or host as labeled",
    meaning:
      "Resource usage compared with the limit or pressure threshold shown on each row.",
    example: "",
    reading:
      "Read the scope and denominator before comparing percentages. No configured limit differs from an unavailable limit. Meter colors change at 75% and 90%. Assessment findings can use different thresholds.",
    limits:
      "A high percentage suggests less remaining capacity; it does not by itself establish a leak.",
    related: ["fds", "cgroupmem", "throttle"],
    source: "Each row names its file in its own topic",
    sourceDetail:
      "Open files: `/proc/PID/fd` and `/proc/PID/limits`. Cgroup memory, CPU quota, and tasks: `memory.*`, `cpu.max`, `cpu.stat`, and `pids.*` in the target cgroup directory under `/sys/fs/cgroup`. Socket memory and backlog: `/proc/PID/net/sockstat` and `/proc/sys/net/`. All are read with each resource sample.",
  },
  cgroupmem: {
    title: "Cgroup memory",
    scope: "Target cgroup · bytes",
    meaning:
      "Memory charged to the target cgroup, including page cache and other tasks in that cgroup.",
    example: "",
    reading:
      "Compare memory.current with memory.max and memory.high. Limit events and OOM kills indicate that a boundary was reached.",
    limits:
      "This value is not the target process RSS. Reclaimable cache can form part of the total.",
    related: ["rss", "pressure"],
    source:
      "`/sys/fs/cgroup/CGROUP/memory.current`, `memory.max`, `memory.high`, `memory.events`",
    sourceDetail:
      "With each resource sample, the sampler reads memory.current, memory.max, memory.high, and the max and oom_kill lines of memory.events in the target cgroup directory. The cgroup path is the last field of `/proc/PID/cgroup` (cgroup v2). Check it yourself: `cat /sys/fs/cgroup$(cut -d: -f3 /proc/PID/cgroup)/memory.current`.",
  },
  throttle: {
    title: "CPU throttling",
    scope: "Cgroup · share of CPU periods",
    meaning:
      "The share of CPU periods in which the cgroup exhausted its CPU quota.",
    example:
      "25% means throttling occurred in one quarter of the observed periods.",
    reading:
      "Compare quota, CPU pressure, and run delay. Tasks can wait for quota even when host cores are idle.",
    limits: "The denominator is CPU periods, not elapsed time.",
    related: ["delay", "pressure", "cpu"],
    source: "`/sys/fs/cgroup/CGROUP/cpu.stat`: nr_throttled ÷ nr_periods",
    sourceDetail:
      "With each resource sample, the sampler reads nr_periods, nr_throttled, and throttled_usec from cpu.stat, and the quota from cpu.max, in the target cgroup directory. The share is the change in nr_throttled divided by the change in nr_periods.",
  },
  pids: {
    title: "Processes & threads",
    scope: "Target cgroup · task count",
    meaning: "Task usage compared with the cgroup pids.max limit.",
    example: "",
    reading:
      "Near the limit, process and thread creation can fail with EAGAIN.",
    limits:
      "The count includes processes and threads in the cgroup, not only the target process.",
    related: ["limits", "churn"],
    source: "`/sys/fs/cgroup/CGROUP/pids.current`, `pids.max`",
    sourceDetail:
      "With each resource sample, the sampler reads pids.current and pids.max in the target cgroup directory.",
  },
  sockmem: {
    title: "TCP memory",
    scope: "Host · socket memory",
    meaning:
      "Socket memory use compared with the host pressure threshold shown on the meter.",
    example: "",
    reading:
      "The kernel can restrict socket buffers under memory pressure. The displayed row also gives the hard memory boundary.",
    limits:
      "These values cover the host and cannot be attributed to one process.",
    related: ["limits", "queues"],
    source: "`/proc/PID/net/sockstat`; `/proc/sys/net/ipv4/tcp_mem`",
    sourceDetail:
      "TCP and UDP memory in use are the mem values (in pages) of `/proc/PID/net/sockstat`. The thresholds are `/proc/sys/net/ipv4/tcp_mem` and `udp_mem`. The largest buffers are `/proc/sys/net/core/rmem_max` and `wmem_max`. All are read with each resource sample.",
  },
  backlog: {
    title: "Accept backlog",
    scope: "Listener · connections",
    meaning:
      "Connections waiting for the application to call accept(), compared with the listener backlog.",
    example: "",
    reading: "Compare backlog use with listen drops and overflows.",
    limits:
      "Listener queues use connection counts, not bytes. A full queue can have several causes.",
    related: ["recvq", "netdrops"],
    source: "sock_diag listener queue; `/proc/sys/net/core/somaxconn`",
    sourceDetail:
      "The sampler lists sockets through sock_diag, the netlink interface that `ss` uses. For a listener, the receive queue is the connections waiting for accept() and the send queue is the backlog limit. somaxconn comes from `/proc/sys/net/core/somaxconn`. Check it yourself: `ss -ltn`.",
  },
  queues: {
    title: "Bytes waiting in the target's sockets",
    scope: "Target sockets · bytes",
    meaning: "Data queued in the target sockets for receiving or sending.",
    example: "",
    reading:
      "Compare unread receive data with send data awaiting transmission or acknowledgement. Charts use the selected resource history range.",
    limits:
      "A queue does not identify a cause by itself. Missing socket coverage is not an empty queue.",
    related: ["recvq", "sendq", "coverage"],
    source: "sock_diag socket list, matched through `/proc/PID/fd`",
    sourceDetail:
      "With each resource sample, the sampler lists the TCP, UDP, and Unix sockets of its network namespace through sock_diag, the netlink interface that `ss` uses. It keeps the sockets whose inode appears as socket:[INODE] in `/proc/PID/fd` and sums their receive and send queues. A target in another network namespace has no socket queues. Check it yourself: `ss -tanp`.",
  },
  recvq: {
    title: "Recv-Q",
    scope: "Socket · bytes; listener · connections",
    meaning:
      "Received bytes waiting for the application to read them. For a listener, connections waiting for accept().",
    example: "",
    reading: "Compare sustained queue growth with receive buffer use.",
    limits:
      "Buffer fill uses queued memory and the buffer limit, which can differ from payload byte counts.",
    related: ["backlog", "queues"],
    source: "sock_diag: receive queue and socket memory",
    sourceDetail:
      "Recv-Q is the receive queue that sock_diag reports for the socket, as `ss` shows it. Buffer fill uses the allocated receive memory and the receive buffer size (rmem_alloc and rcvbuf) from the same list, as `ss -m` shows them.",
  },
  sendq: {
    title: "Send-Q",
    scope: "Socket · queued bytes",
    meaning:
      "Bytes not yet sent or acknowledged, depending on the socket kind.",
    example: "",
    reading:
      "Compare queue growth with send buffer use, RTT, and retransmissions.",
    limits: "Queued data alone does not prove that the peer is slow.",
    related: ["rtt", "retrans", "queues"],
    source: "sock_diag: send queue and socket memory",
    sourceDetail:
      "Send-Q is the send queue that sock_diag reports for the socket, as `ss` shows it. Buffer fill uses the queued send memory and the send buffer size (wmem_queued and sndbuf) from the same list, as `ss -m` shows them.",
  },
  rtt: {
    title: "RTT",
    scope: "TCP socket · time",
    meaning: "Smoothed round-trip time for the socket.",
    example: "",
    reading: "Compare sustained changes with retransmissions and queue growth.",
    limits: "RTT is not the application request or message-processing time.",
    related: ["retrans", "sendq"],
    source: "sock_diag `tcp_info`: tcpi_rtt",
    sourceDetail:
      "The sampler asks sock_diag for the kernel tcp_info of each TCP socket of the target, which `ss -ti` also shows. RTT is tcpi_rtt, the smoothed round-trip time in microseconds.",
  },
  retrans: {
    title: "TCP retransmits",
    scope: "TCP segments · displayed scope and interval",
    meaning:
      "TCP segments sent again after loss or other delivery uncertainty.",
    example: "",
    reading:
      "Per-socket values cover one socket. Resource counters cover the target network namespace.",
    limits:
      "Retransmissions do not identify where on the path the problem occurred.",
    related: ["rtt", "netdrops"],
    source:
      "Per socket: `tcp_info`; namespace: `/proc/PID/net/snmp` RetransSegs",
    sourceDetail:
      "Per-socket values are tcpi_total_retrans from tcp_info through sock_diag, which `ss -ti` also shows. Namespace values are the Tcp RetransSegs counter of `/proc/PID/net/snmp`.",
  },
  netdrops: {
    title: "Network drops",
    scope: "Target network namespace",
    meaning:
      "Selected counters for dropped packets or connections in the target network namespace.",
    example:
      "Example: 0/s, 20, and 500 mean no events in the latest interval, 20 in the selected range, and a cumulative count of 500.",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["health", "retrans", "coverage"],
    source: "`/proc/PID/net/netstat`, `snmp`, `snmp6`, and `dev`",
    sourceDetail:
      "With each resource sample, the sampler reads counters from `/proc/PID/net/netstat` (TcpExt), `/proc/PID/net/snmp` (Tcp and Udp), `/proc/PID/net/snmp6` (Udp6, added to Udp), and `/proc/PID/net/dev` (every interface except lo). These files describe the network namespace of the target. Each counter topic names its line. Check it yourself: `cat /proc/PID/net/netstat`.",
  },
  endpoint: {
    title: "Socket",
    scope: "Socket identity and state",
    meaning:
      "Socket kind, current state, and the local and peer endpoint identify an observed socket.",
    example: "",
    reading:
      "Compare queue use and errors for the same endpoint. Unnamed Unix sockets need not have a path.",
    limits:
      "A socket can disappear between samples. State and endpoint alone do not identify the owning application operation.",
    related: ["queues", "coverage"],
    source: "sock_diag socket list",
    sourceDetail:
      "Kind, state, and the local and peer addresses come from the sock_diag entry of the socket, as `ss -tuxan` lists them. Unix socket paths come from the same list. A socket belongs to the target when its inode appears in `/proc/PID/fd`.",
  },
  sockdrops: {
    title: "Socket drops",
    scope: "Socket · packets",
    meaning:
      "Packets this socket dropped, as reported by the kernel. + shows drops in the latest interval.",
    example: "",
    reading:
      "Compare with receive buffer use: drops on a full buffer mean the application did not read fast enough.",
    limits:
      "Namespace-wide drop counters are in Network drops. A counter can reset when the socket is recreated.",
    related: ["recvq", "netdrops", "endpoint"],
    source: "sock_diag socket memory: drops",
    sourceDetail:
      "The drop count in the socket memory information (SK_MEMINFO_DROPS) of the sock_diag list, which `ss -m` shows as d. The collector shows the change since the previous resource sample.",
  },
  closewait: {
    title: "CLOSE-WAIT",
    scope: "TCP sockets",
    meaning:
      "The peer closed its side, but the local application has not closed its socket.",
    example: "",
    reading:
      "A sustained or growing count can indicate missing socket cleanup.",
    limits: "A brief CLOSE-WAIT state can be normal during shutdown.",
    related: ["endpoint", "fds"],
    source: "sock_diag socket states",
    sourceDetail:
      "The number of target TCP sockets that sock_diag reports in the CLOSE-WAIT state. Check it yourself: `ss -tan state close-wait`.",
  },
  coverage: {
    title: "Data coverage",
    scope: "Available observations",
    meaning:
      "Coverage notes identify missing, partial, stale, or unavailable observations.",
    example: "",
    reading:
      "Read the supplied reason and the last sample time. A dash means not available; a numeric zero means measured zero.",
    limits: "Do not treat gaps or unreadable values as zero activity.",
    related: ["health"],
    source: "Flags sent with each sample",
    sourceDetail:
      "The sampler marks data it could not read completely, such as a cut socket list or an unreadable file. The collector marks samples as stale when they are old.",
  },
  "net-listen_overflows": {
    title: "Accept queue overflows",
    scope: "Target network namespace",
    meaning:
      "A listener’s accept queue was full and a new connection was dropped. The app is not calling accept() fast enough, or the backlog (listen(), somaxconn) is too small.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: ListenOverflows",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: ListenOverflows. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-listen_drops": {
    title: "Listen drops",
    scope: "Target network namespace",
    meaning: "Every dropped incoming connection attempt, overflows included.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: ListenDrops",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: ListenDrops. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_req_q_full_drop": {
    title: "SYN queue full",
    scope: "Target network namespace",
    meaning:
      "Half-open connections were dropped because the SYN queue was full.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: TCPReqQFullDrop",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPReqQFullDrop. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-syncookies_sent": {
    title: "SYN cookies sent",
    scope: "Target network namespace",
    meaning:
      "The SYN queue overflowed and the kernel fell back to SYN cookies: a connection burst, a flood, or a slow accept loop.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: SyncookiesSent",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: SyncookiesSent. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_backlog_drop": {
    title: "Socket backlog drops",
    scope: "Target network namespace",
    meaning:
      "Packets dropped while the app held the socket lock and the socket backlog was full.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: TCPBacklogDrop",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPBacklogDrop. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_rcvq_drop": {
    title: "Receive queue drops",
    scope: "Target network namespace",
    meaning:
      "Packets dropped because a TCP receive buffer was full: a slow reader.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: TCPRcvQDrop",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPRcvQDrop. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_zero_window_drop": {
    title: "Zero-window drops",
    scope: "Target network namespace",
    meaning:
      "Packets dropped because the receiver had advertised a zero window.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: TCPZeroWindowDrop",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPZeroWindowDrop. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-prune_called": {
    title: "Receive queue pruning",
    scope: "Target network namespace",
    meaning:
      "The kernel had to collapse receive queues to stay within buffer limits: a slow reader or a small SO_RCVBUF.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: PruneCalled",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: PruneCalled. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-rcv_pruned": {
    title: "Packets pruned",
    scope: "Target network namespace",
    meaning: "Packets thrown away from receive queues under memory limits.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: RcvPruned",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: RcvPruned. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-ofo_pruned": {
    title: "Out-of-order pruned",
    scope: "Target network namespace",
    meaning: "Out-of-order packets thrown away under memory limits.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: OfoPruned",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: OfoPruned. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_retrans_segs": {
    title: "Retransmitted segments",
    scope: "Target network namespace",
    meaning: "Segments sent again: packet loss or congestion on some path.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/snmp` Tcp: RetransSegs",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Tcp: RetransSegs. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_timeouts": {
    title: "Retransmission timeouts",
    scope: "Target network namespace",
    meaning:
      "A retransmission timer fired: a peer went quiet or the loss was severe.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: TCPTimeouts",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPTimeouts. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_abort_on_timeout": {
    title: "Aborted after timeouts",
    scope: "Target network namespace",
    meaning: "Connections given up after repeated timeouts.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: TCPAbortOnTimeout",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPAbortOnTimeout. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_estab_resets": {
    title: "Connections reset",
    scope: "Target network namespace",
    meaning: "Established connections reset, by the peer or locally.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/snmp` Tcp: EstabResets",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Tcp: EstabResets. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_attempt_fails": {
    title: "Failed connection attempts",
    scope: "Target network namespace",
    meaning: "Outgoing connections that failed (refused or timed out).",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/snmp` Tcp: AttemptFails",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Tcp: AttemptFails. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_memory_pressures": {
    title: "TCP memory pressure",
    scope: "Target network namespace",
    meaning:
      "The kernel entered TCP memory pressure and started shrinking socket buffers (net.ipv4.tcp_mem).",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: TCPMemoryPressures",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPMemoryPressures. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-tcp_abort_on_memory": {
    title: "Aborted for memory",
    scope: "Target network namespace",
    meaning: "Connections aborted because TCP memory was exhausted.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/netstat` TcpExt: TCPAbortOnMemory",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/netstat` TcpExt: TCPAbortOnMemory. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-udp_rcvbuf_errors": {
    title: "UDP receive buffer full",
    scope: "Target network namespace",
    meaning:
      "Datagrams dropped because a receive buffer was full: a UDP reader is too slow or its SO_RCVBUF too small.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source:
      "`/proc/PID/net/snmp` Udp: RcvbufErrors, plus Udp6RcvbufErrors in `snmp6`",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Udp: RcvbufErrors, plus Udp6RcvbufErrors in `snmp6`. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-udp_sndbuf_errors": {
    title: "UDP send buffer full",
    scope: "Target network namespace",
    meaning: "Sends that failed because the send buffer was full.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source:
      "`/proc/PID/net/snmp` Udp: SndbufErrors, plus Udp6SndbufErrors in `snmp6`",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Udp: SndbufErrors, plus Udp6SndbufErrors in `snmp6`. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-udp_in_errors": {
    title: "UDP input errors",
    scope: "Target network namespace",
    meaning:
      "Datagrams that could not be delivered, including receive-buffer drops.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/snmp` Udp: InErrors, plus Udp6InErrors in `snmp6`",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Udp: InErrors, plus Udp6InErrors in `snmp6`. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-udp_mem_errors": {
    title: "UDP memory errors",
    scope: "Target network namespace",
    meaning:
      "Datagrams dropped because UDP memory (net.ipv4.udp_mem) was exhausted.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source:
      "`/proc/PID/net/snmp` Udp: MemErrors, plus Udp6MemErrors in `snmp6`",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Udp: MemErrors, plus Udp6MemErrors in `snmp6`. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-udp_no_ports": {
    title: "UDP to closed ports",
    scope: "Target network namespace",
    meaning: "Datagrams to ports nobody listens on.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source: "`/proc/PID/net/snmp` Udp: NoPorts, plus Udp6NoPorts in `snmp6`",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/snmp` Udp: NoPorts, plus Udp6NoPorts in `snmp6`. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-if_rx_dropped": {
    title: "Interface receive drops",
    scope: "Target network namespace",
    meaning:
      "A network interface dropped incoming packets before any socket saw them (ring or queue full). Summed over the namespace’s interfaces except lo.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source:
      "`/proc/PID/net/dev` receive drop, summed over interfaces except lo",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/dev` receive drop, summed over interfaces except lo. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-if_tx_dropped": {
    title: "Interface transmit drops",
    scope: "Target network namespace",
    meaning:
      "A network interface dropped outgoing packets (queue full or link trouble).",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source:
      "`/proc/PID/net/dev` transmit drop, summed over interfaces except lo",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/dev` transmit drop, summed over interfaces except lo. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-if_rx_errors": {
    title: "Interface receive errors",
    scope: "Target network namespace",
    meaning:
      "Bad frames, CRC or length errors on a network interface: cabling, driver or hardware.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source:
      "`/proc/PID/net/dev` receive errs, summed over interfaces except lo",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/dev` receive errs, summed over interfaces except lo. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  "net-if_tx_errors": {
    title: "Interface transmit errors",
    scope: "Target network namespace",
    meaning: "Transmit errors on a network interface: driver or hardware.",
    example: "",
    reading:
      "Rate (/s) is events per second over the latest sample interval. In range adds events from available samples in the selected time range. Total is the kernel counter and can include events before monitoring started. Read each counter definition.",
    limits:
      "Other processes can contribute. Counter resets, gaps, and partial coverage can limit comparisons.",
    related: ["netdrops", "coverage"],
    source:
      "`/proc/PID/net/dev` transmit errs, summed over interfaces except lo",
    sourceDetail:
      "With each resource sample, the sampler reads `/proc/PID/net/dev` transmit errs, summed over interfaces except lo. The file describes the network namespace of the target. Now and In range use changes of this cumulative counter; Total is the counter itself.",
  },
  memmap: {
    title: "Memory map",
    scope: "Target process · virtual address space",
    meaning:
      "The address ranges the target has mapped, read from /proc/PID/maps, with their kind, size, and limits.",
    example: "",
    reading:
      "Start with the findings and limits, then select a region in the address-space view to zoom in. Compare mapped sizes with RSS.",
    limits:
      "Mapped memory is not resident memory. A layout is sampled less often than threads, so short-lived mappings can be missed.",
    related: ["amap", "vmsize", "rss"],
    source: "`/proc/PID/maps` and `/proc/PID/status`",
    sourceDetail:
      "With each memory sample (every 30 s by default), the sampler reads `/proc/PID/maps` in small parts within a time budget, and the Vm lines of `/proc/PID/status`. The collector serves the layout through `/api/memory-map`. Check it yourself: `cat /proc/PID/maps`.",
  },
  memkinds: {
    title: "Anonymous / file / shared",
    scope: "Process · resident bytes by kind",
    meaning:
      "Resident memory split into anonymous pages (heap, arenas, stacks), file-backed pages, and shared memory: RssAnon, RssFile, and RssShmem.",
    example: "",
    reading:
      "Growth in anonymous memory usually comes from allocations. File pages can be reclaimed and re-read.",
    limits:
      "The split comes from resource samples and needs them to be available. Shared pages count in full for each process that maps them.",
    related: ["rss", "anonres", "cgroupmem"],
    source: "`/proc/PID/status`: RssAnon, RssFile, RssShmem",
    sourceDetail:
      "With each resource sample, the sampler reads RssAnon, RssFile, and RssShmem from `/proc/PID/status`. Their sum is VmRSS.",
  },
  vmas: {
    title: "Mappings (VMAs)",
    scope: "Process · count and vm.max_map_count",
    meaning:
      "The number of virtual memory areas (VMAs) in the address space, compared with the host vm.max_map_count limit.",
    example: "",
    reading:
      "At the limit, mmap() and thread creation can fail with ENOMEM. A steady rise can indicate mappings that are never released.",
    limits:
      "Adjacent regions can merge or split without a change in memory use.",
    related: ["memregions", "vmsize", "memlimits"],
    source: "Lines of `/proc/PID/maps`; `/proc/sys/vm/max_map_count`",
    sourceDetail:
      "Each line of `/proc/PID/maps` is one VMA; the sampler counts them with each memory sample. The limit is `/proc/sys/vm/max_map_count`. Check it yourself: `wc -l < /proc/PID/maps`.",
  },
  memfindings: {
    title: "Memory findings",
    scope: "Fixed rules applied in the browser",
    meaning:
      "Conditions in the memory map, resource, and thread samples that deserve inspection, such as swap use or a stack close to its limit.",
    example: "",
    reading:
      "Read the severity and detail of each finding, then check the matching tile, limit, or region.",
    limits:
      "These are rules of thumb, not a diagnosis. They use only the latest samples.",
    related: ["assessment", "memlimits", "amap"],
    source: "Computed in this page",
    sourceDetail:
      "This page applies fixed rules to the latest memory, resource, and thread samples. Each finding names the value it used.",
  },
  amap: {
    title: "Address space map",
    scope: "Process · mappings, high addresses at the top",
    meaning:
      "One bar per group of adjacent mappings of the same kind. Color shows the kind; the darker part is the size on a log scale from 4 KiB to the largest bar.",
    example: "",
    reading:
      "Look for unexpectedly large anonymous or heap regions. Select a bar to zoom into its pages and regions.",
    limits:
      "Gaps between mappings are shortened. A large bar can use little RAM because mapped is not resident.",
    related: ["memzoom", "memkinds", "vmsize"],
    source: "`/proc/PID/maps`",
    sourceDetail:
      "Each bar groups adjacent lines of `/proc/PID/maps` of the same kind. The kind comes from the path column ([heap], [stack], a file, or none for anonymous memory) and the permissions.",
  },
  memzoom: {
    title: "Region zoom",
    scope: "Selected address-space bar",
    meaning:
      "The selected bar in detail: mapped size, address span, member regions, and a page grid of what /proc/PID/maps shows at each address.",
    example:
      "A 64 KiB span with 48 KiB mapped has 16 KiB not mapped inside it.",
    reading:
      "Compare the span with the mapped size to see holes. Unknown coverage is distinct from unmapped space. Squares outlined as new were mapped since the previous layout.",
    limits:
      "The grid shows mappings, not residency. Page size comes from the sampler host. If it is unknown, cells show bytes without page counts. KiB and MiB use powers of 1,024.",
    related: ["amap", "memregions", "heap", "memgap", "heapmargin"],
    source: "`/proc/PID/maps`; page size of the sampler host",
    sourceDetail:
      "The grid shows the address ranges of `/proc/PID/maps`. The page size is sysconf(_SC_PAGESIZE) on the sampler host.",
  },
  memgap: {
    title: "Largest unmapped gap",
    scope: "Selected bar · complete current layout",
    meaning: "The longest uncovered address interval inside the selected bar.",
    example: "Two mappings separated by 64 KiB have a 64 KiB gap.",
    reading:
      "Compare with the total not mapped inside the bar. Unknown coverage is shown separately from unmapped space.",
    limits:
      "An unmapped gap is not an allocator free block. Incomplete, stale, or historical layouts cannot supply this value.",
    related: ["memzoom", "memregions"],
    source: "Computed from `/proc/PID/maps`",
    sourceDetail:
      "The longest range inside the bar that no line of `/proc/PID/maps` covers.",
  },
  heapmargin: {
    title: "Heap display margin",
    scope: "Heap zoom · extended display range",
    meaning:
      "The grid includes a small margin above the page-aligned heap mapping end. Neighboring mappings keep their own colors.",
    example: "",
    reading:
      "Watch existing grid cells change as the heap grows. The display span stays fixed until the heap leaves it. Heap facts still describe only the selected heap.",
    limits:
      "The margin is capped at 1 MiB and requires a complete current layout. Selection or target changes reset it. The mapping end is not the exact program break.",
    related: ["heapend", "memzoom"],
    source: "Display range around the [heap] line of `/proc/PID/maps`",
    sourceDetail:
      "A display choice of this page. The addresses come from `/proc/PID/maps`.",
  },
  heap: {
    title: "Heap size",
    scope: "Process · [heap] mapping over time",
    meaning:
      "The size of the brk heap. It grows up when the allocator calls brk.",
    example: "",
    reading:
      "A sustained rise, together with RSS growth, can indicate allocation growth.",
    limits:
      "Many allocators also use mmap arenas. Size change uses samples collected while this page was open and shows their measured interval. It is not an exact program-break movement.",
    related: ["anonres", "stack", "memkinds"],
    source: "The [heap] line of `/proc/PID/maps`",
    sourceDetail:
      "The size of the [heap] line of `/proc/PID/maps` (end address minus start address) in each memory sample. Check it yourself: `grep heap /proc/PID/maps`.",
  },
  heapend: {
    title: "Heap mapping end",
    scope: "Process · page-aligned heap boundary",
    meaning:
      "The upper address of the heap mapping, plotted as a byte offset from the first available sample in this chart.",
    example: "An offset of +64 KiB means the mapping end moved up by 64 KiB.",
    reading:
      "Read steps as sampled changes. The rate uses the measured sample times.",
    limits:
      "This is not the exact program break. Missing samples leave gaps. History resets when the target or sampler session changes.",
    related: ["heap", "stackstart"],
    source: "End address of the [heap] line of `/proc/PID/maps`",
    sourceDetail:
      "The end address of the [heap] line of `/proc/PID/maps` in each memory sample.",
  },
  stackstart: {
    title: "Main stack start",
    scope: "Main thread · lower mapping boundary",
    meaning:
      "The lower address of the main stack mapping, plotted as an offset from the first available sample in this chart.",
    example: "An offset of −64 KiB means the mapping grew down by 64 KiB.",
    reading:
      "A downward step means a lower mapping start. Read mapped size in the selected stack facts.",
    limits:
      "The mapping boundary does not measure stack depth. Missing samples leave gaps.",
    related: ["stack", "heapend"],
    source: "Start address of the [stack] line of `/proc/PID/maps`",
    sourceDetail:
      "The start address of the [stack] line of `/proc/PID/maps` in each memory sample.",
  },
  vmdata: {
    title: "Data + heap (VmData)",
    scope: "Process · VmData from /proc/PID/status",
    meaning:
      "The size of the process's private data segments: the brk heap, the data and BSS segments, and private writable mmap memory such as allocator arenas and thread stacks.",
    example: "",
    reading:
      "VmData can grow while the [heap] mapping stays fixed, when the allocator uses mmap. Compare it with Heap size and Resident anonymous to see where the growth is.",
    limits:
      "It counts mapped address space, not resident memory. Memory that was never touched still counts.",
    related: ["heap", "anonres", "memkinds"],
    source: "`/proc/PID/status`: VmData",
    sourceDetail:
      "With each memory sample, the sampler reads the VmData line of `/proc/PID/status`.",
  },
  stack: {
    title: "Main stack",
    scope: "Main thread · [stack] mapping and RLIMIT_STACK",
    meaning:
      "The size of the main thread stack mapping. It grows down when a page fault touches below it.",
    example: "",
    reading:
      "Compare with RLIMIT_STACK. Near the limit, deep recursion can crash the process with SIGSEGV.",
    limits:
      "Other threads have their own stacks inside anonymous mappings. The mapping does not shrink when the stack unwinds. Size change shows the measured interval between samples while this page was open.",
    related: ["heap", "memlimits"],
    source: "[stack] in `/proc/PID/maps`; `/proc/PID/limits`: Max stack size",
    sourceDetail:
      "The size of the [stack] line of `/proc/PID/maps`, compared with the soft Max stack size of `/proc/PID/limits`. Check it yourself: `grep stack /proc/PID/maps`.",
  },
  aslimit: {
    title: "Address space limit",
    scope: "Process · RLIMIT_AS",
    meaning: "Virtual size compared with the RLIMIT_AS resource limit.",
    example: "",
    reading: "At the limit, mmap() and malloc() fail even when RAM is free.",
    limits: "RLIMIT_AS counts reserved address space, not RAM.",
    related: ["vmsize", "memlimits"],
    source: "`/proc/PID/limits`: Max address space",
    sourceDetail:
      "The soft value of the Max address space line of `/proc/PID/limits`. Check it yourself: `prlimit --as --pid PID`.",
  },
  anonres: {
    title: "Resident anonymous",
    scope: "Process · RssAnon over time",
    meaning:
      "Anonymous memory currently in RAM: heap, arenas, thread stacks, and private mmap memory.",
    example: "",
    reading:
      "A sustained slope, shown per minute, is a better growth signal than virtual size.",
    limits:
      "Swapped anonymous pages leave this total. The chart covers only the time this page was open.",
    related: ["memkinds", "heap", "rss"],
    source: "`/proc/PID/status`: RssAnon",
    sourceDetail:
      "With each resource sample (every 2 s by default), the sampler reads the RssAnon line of `/proc/PID/status`.",
  },
  threadstacks: {
    title: "Thread stacks",
    scope: "Other threads · reserved mappings and residency",
    meaning:
      "Common pthread stacks reserve a fixed address range. The number of resident pages can change inside that range.",
    example: "",
    reading:
      "A fixed mapping size does not mean fixed memory use. The main stack boundary chart covers only the main thread.",
    limits:
      "Other runtimes can manage stacks differently. Residency does not measure current stack depth.",
    related: ["stack", "anonres", "memregions"],
    source: "Anonymous lines of `/proc/PID/maps`",
    sourceDetail:
      "The dashboard does not measure the residency of each thread stack. Thread stacks appear as anonymous lines in `/proc/PID/maps`, usually with a guard page below them.",
  },
  memregions: {
    title: "Memory regions",
    scope: "Selected bar · mappings",
    meaning:
      "The regions in the selected bar, with their start address, size, permissions, and VMA count.",
    example: "r-xp is readable, executable, and private.",
    reading:
      "Use the name and permissions to tell code, data, and guard regions apart.",
    limits:
      "Only the first 300 regions are listed. Permissions are the union over the region's mappings.",
    related: ["memzoom", "vmas"],
    source: "`/proc/PID/maps`",
    sourceDetail:
      "The start address, size, and permissions of the merged lines of `/proc/PID/maps`.",
  },
  memlimits: {
    title: "Memory limits & headroom",
    scope: "Process and host limits as labeled",
    meaning:
      "Limits that make mmap, malloc, or thread creation fail, or stop the main stack from growing, with related memory counters.",
    example: "",
    reading:
      "Read each meter's denominator. Page tables and locked memory are also charged to the process.",
    limits:
      "No configured limit is different from an unknown limit. The longest maps read shows the sampler's own cost.",
    related: ["vmas", "aslimit", "stack"],
    source:
      "`/proc/PID/limits`, `/proc/PID/status`, `/proc/sys/vm/max_map_count`",
    sourceDetail:
      "Max address space and Max stack size come from `/proc/PID/limits`. VmPTE (page tables) and VmLck (locked) come from `/proc/PID/status`. The mapping limit is `/proc/sys/vm/max_map_count`. The sampler measures the time of its own maps reads.",
  },
  faulttotals: {
    title: "Page faults since start",
    scope: "Process · cumulative count since the process started",
    meaning:
      "Total major and minor page faults since the process started. A major fault needed I/O to bring a page in; a minor fault was resolved without I/O, for example by mapping a zero page or a cached file page.",
    example:
      "0 major · 100,000 minor means no fault needed I/O and many were resolved in memory.",
    reading:
      "Minor faults are normal and grow as memory is first touched. Compare how fast the major count climbs, or see Major faults for the per-second rate.",
    limits:
      "These are counts, not rates, so they only grow and say nothing about what is happening now.",
    related: ["faults", "rss"],
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
