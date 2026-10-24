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
} as const satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof helpTopics;

export function isHelpTopicId(value: string): value is HelpTopicId {
  return Object.hasOwn(helpTopics, value);
}
