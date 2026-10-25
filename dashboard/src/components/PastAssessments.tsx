import { Help } from "../help/Help";
import type { FindingType, Level } from "../lib/findings";
import { LEVEL_ICONS } from "../lib/findings";
import { date } from "../lib/format";
import type { Episode, Scan } from "../lib/pastAssessments";
import { Fold } from "./Fold";

export const HISTORY_TYPES: Record<FindingType, string> = {
  monitor: "Monitoring",
  threads: "Threads & CPU",
  watched: "Watched threads",
  resources: "Resources & network",
  memory: "Memory",
};
export const HISTORY_LEVELS = [
  ["critical", "Critical"],
  ["serious", "Serious"],
  ["warning", "Warning"],
  ["info", "Info"],
] as const satisfies readonly (readonly [Level, string])[];
export interface HistoryFilter {
  levels: ReadonlySet<Level>;
  type: FindingType | "";
}
export const initialFilter: HistoryFilter = {
  levels: new Set<Level>(["critical", "serious", "warning"]),
  type: "",
};
export const shownEpisodes = (
  all: readonly Episode[],
  { levels, type }: HistoryFilter,
) =>
  all.filter(
    (episode) => levels.has(episode.level) && (!type || episode.type === type),
  );

const sameDay = (a: number, b: number) =>
  new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
const plural = (count: number, word: string) =>
  `${String(count)} ${word}${count === 1 ? "" : "s"}`;

function when(episode: Episode) {
  const end =
    episode.last > episode.first
      ? ` – ${sameDay(episode.first, episode.last) ? new Date(episode.last * 1000).toLocaleTimeString() : date(episode.last)}`
      : "";
  const count =
    episode.count > 1
      ? ` · in ${String(episode.count)} checked recordings`
      : "";
  return `${date(episode.first)}${end} · ${HISTORY_TYPES[episode.type]}${count}`;
}

function status(
  scan: Scan,
  all: readonly Episode[],
  shown: number,
  recordings: boolean,
) {
  if (scan.error) return `${scan.error} Select Load earlier to try again.`;
  if (scan.oldest === null)
    return scan.busy
      ? "Checking the latest recordings…"
      : recordings
        ? ""
        : "No recordings to check.";
  const checked = scan.samples.filter(Boolean).length,
    gaps = scan.samples.length - checked;
  return (
    `${scan.busy === "older" ? "Checking an earlier period… " : ""}Checked ${plural(checked, "recording")} back to ${date(scan.oldest)}${scan.done ? " (the oldest recording)" : ""}.` +
    (gaps
      ? ` ${String(gaps)} checked time${gaps === 1 ? " had" : "s had"} no recording.`
      : "") +
    ` Showing ${String(shown)} of ${plural(all.length, "finding")}.`
  );
}

export function PastAssessments({
  scan,
  episodes: all,
  filter,
  onFilter,
  recordings,
  viewingAt,
  selected,
  onSelect,
  onLoadOlder,
}: {
  scan: Scan;
  episodes: readonly Episode[];
  filter: HistoryFilter;
  onFilter: (filter: HistoryFilter) => void;
  /** The collector has recordings. */
  recordings: boolean;
  /** The displayed recording time, or null outside recorded mode. */
  viewingAt: number | null;
  selected: string | null;
  onSelect: (episode: Episode) => void;
  onLoadOlder: () => void;
}) {
  const shown = shownEpisodes(all, filter);
  return (
    <Fold
      name="past"
      className="fold past"
      summary={
        <>
          <Help topic="assesshistory" as="div">
            <h3>Past assessments</h3>
          </Help>
          <Help topic="assesshistory">
            <span id="past-count" className="muted">
              {scan.oldest === null ? "" : plural(shown.length, "finding")}
            </span>
          </Help>
        </>
      }
    >
      <div className="history-filters">
        <Help topic="historyfilters">
          <fieldset id="history-levels">
            <legend>Severity</legend>
            {HISTORY_LEVELS.map(([level, label]) => (
              <label key={level}>
                <input
                  type="checkbox"
                  value={level}
                  checked={filter.levels.has(level)}
                  onChange={(event) => {
                    const levels = new Set(filter.levels);
                    if (event.currentTarget.checked) levels.add(level);
                    else levels.delete(level);
                    onFilter({ ...filter, levels });
                  }}
                />{" "}
                {label}
              </label>
            ))}
          </fieldset>
        </Help>
        <Help topic="historyfilters">
          <label>
            Type{" "}
            <select
              id="history-type"
              value={filter.type}
              onChange={(event) => {
                const value = event.currentTarget.value;
                onFilter({
                  ...filter,
                  type: value in HISTORY_TYPES ? (value as FindingType) : "",
                });
              }}
            >
              <option value="">All types</option>
              {Object.entries(HISTORY_TYPES).map(([type, label]) => (
                <option key={type} value={type}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </Help>
      </div>
      <ul
        id="history-list"
        className="findings history-list"
        onScroll={(event) => {
          // Reaching the end of the list loads an earlier period.
          const list = event.currentTarget;
          if (list.scrollTop + list.clientHeight >= list.scrollHeight - 24)
            onLoadOlder();
        }}
      >
        {scan.oldest !== null && !shown.length && (
          <li className="muted">
            <Help topic="assesshistory">
              {all.length
                ? "No findings match these filters."
                : "The Assessment found nothing in the checked recordings."}
            </Help>
          </li>
        )}
        {shown.map((episode) => {
          const current = selected === episode.id && viewingAt === episode.at;
          const select = () => {
            onSelect(episode);
          };
          return (
            <li
              key={episode.id}
              className={`finding lvl-${episode.level}`}
              aria-current={current}
              data-action="1"
              tabIndex={0}
              onClick={select}
              onKeyDown={(event) => {
                if (event.key === "Enter") select();
              }}
            >
              <span className="ic" aria-label={episode.level}>
                {LEVEL_ICONS[episode.level]}
              </span>
              <Help topic="assesshistory" as="div">
                <div className="t">{episode.item.title}</div>
                <div className="when">{when(episode)}</div>
                {/* The selected row also shows the detail. */}
                {current && <div className="d">{episode.item.detail}</div>}
              </Help>
            </li>
          );
        })}
      </ul>
      <div className="past-foot">
        <Help topic="assesshistory">
          <span id="history-status" className="muted" role="status">
            {status(scan, all, shown.length, recordings)}
          </span>
        </Help>
        {!scan.done && (scan.oldest !== null || scan.error) && (
          <Help topic="assesshistory">
            <button
              id="history-more"
              type="button"
              disabled={scan.busy !== null}
              onClick={onLoadOlder}
            >
              {scan.busy === "older" ? "Loading…" : "Load earlier"}
            </button>
          </Help>
        )}
      </div>
    </Fold>
  );
}
