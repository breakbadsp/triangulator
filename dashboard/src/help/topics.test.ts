import { expect, test } from "vitest";
import { helpTopics, helpTopicIds } from "./topics";
// Pinned 1885, 1898 and the explicit-ID replacement for 1914.
test("all topic links resolve and every measurement names a balanced source", () => {
  const controls = new Set([
    "appearance",
    "fleet-density",
    "fleet-filter",
    "section-navigation",
    "watchprefix",
    "watchwake",
    "watchremove",
    "watchadd",
    "watchsave",
    "watchreload",
    "watchreset",
  ]);
  expect(helpTopicIds.length).toBeGreaterThan(140);
  for (const id of helpTopicIds) {
    const topic = helpTopics[id];
    for (const related of topic.related)
      expect(Object.hasOwn(helpTopics, related), `${id} -> ${related}`).toBe(
        true,
      );
    if (!controls.has(id)) {
      expect(topic.source, id).not.toBe("");
      expect(topic.sourceDetail, id).not.toBe("");
    }
    expect(
      ((topic.source + topic.sourceDetail).match(/`/g) ?? []).length % 2,
      id,
    ).toBe(0);
  }
  expect(helpTopics.delay.source).toContain("schedstat");
  expect(helpTopics["net-listen_overflows"].source).toContain(
    "TcpExt: ListenOverflows",
  );
  expect(helpTopics.throttle.scope).toContain("CPU periods");
  expect(helpTopics.demand.scope).not.toBe(helpTopics.delay.scope);
  expect(helpTopics.socket.meaning).not.toBe(helpTopics.endpoint.meaning);
});
