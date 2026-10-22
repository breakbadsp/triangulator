# Dashboard contextual help

- Keep one explanation per topic. Reuse it in hover cards, guides, and the page guide to prevent conflicting descriptions.
- Use delayed help so pointer movement across live tables does not produce unwanted cards. The selected delay is 1,200 ms.
- Keep short cards noninteractive. Put links, examples, and longer explanations in explicit guides.
- Provide keyboard and touch access. Hover alone cannot serve every user.
- Keep help dismissible and readable while the pointer moves into it. Follow [W3C hover and focus guidance](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html).
- Freeze the explanation and its timestamp while it is open. Live updates must not change the text during reading.
- Explain scope, units, unavailable values, uncertainty, and source. A plausible number without its limits can mislead.
- Keep the thread drawer and guide from covering each other. Preserve the user's investigation when returning.

## Help for new dashboard features

- Give every visible section, card, chart, label, column, legend, and disclosure a contextual topic in the same change.
- Give each measured value a source explanation. Controls and appearance settings do not need a measurement source.
- Keep generic labels tied to an explicit topic. An alias must identify one topic.
- Check each new label in a real browser. Static tests cannot prove hover, focus, touch, or live-update behavior.
- Add or update the [manual case](qa/test-cases.md). Keep unexecuted cases `NOT_RUN`.
- Implementation and content: [dashboard.html](../collector/dashboard.html). Automated coverage: [dashboard_test.js](../tests/dashboard_test.js).
