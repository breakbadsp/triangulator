import { expect, test } from "vitest";
import { helpTopics, helpTopicIds } from "./topics";
// Pinned 1885, 1898 and the explicit-ID replacement for 1914.
test("every measurement retains its source with balanced code spans", () => {
  const controls = new Set([
    "appearance",
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
    expect(Object.keys(topic).sort(), id).toEqual(
      topic.source
        ? ["source", "sourceDetail", "title"]
        : ["meaning", "source", "sourceDetail", "title"],
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
  expect(helpTopics.socket.source).not.toBe(helpTopics.endpoint.source);
});
