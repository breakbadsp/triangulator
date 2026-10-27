# Dashboard contextual help

- Keep one explanation per topic. Reuse it in chart readout cards, guides, and the page guide to prevent conflicting descriptions.
- Open help only on request. Automatic cards covered the data that the reader was looking at. Each help label shows a quiet ⓘ button when the reader points at it or focuses it, and always on touch screens. The button opens the metric guide.
- Show the guide beside the dashboard, never over it. At 760 px and wider, the guide is a right-side panel that pushes the page aside. Narrower screens have no room for both, so there the guide is a modal sheet.
- Keep help simple. It is not a critical feature, so prefer one shared component and few tests to per-label code.
- Chart readouts still open a card after a hover delay, because they show the values at the pointer. Table bodies and chart wrappers have no ⓘ button.
- Provide keyboard and touch access. Hover alone cannot serve every user.
- Keep help dismissible and readable while the pointer moves into it. Follow [W3C hover and focus guidance](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html).
- Freeze the explanation and its timestamp while it is open. Live updates must not change the text during reading.
- Explain scope, units, unavailable values, uncertainty, and source. A plausible number without its limits can mislead.
- Keep the thread drawer and guide from covering each other. Preserve the user's investigation when returning.

## Help for new dashboard features

- Give every visible section, card, chart, label, column, legend, and disclosure a contextual topic in the same change.
- Give each measured value a source explanation. Controls and appearance settings do not need a measurement source.
- Use explicit, type-checked topic IDs for generic labels and related links.
- Check each new label in a real browser. Static tests cannot prove hover, focus, touch, or live-update behavior.
- Add or update the [manual case](qa/test-cases.md). Keep unexecuted cases `NOT_RUN`.
- Implementation and content: [dashboard/src/help/](../dashboard/src/help/). Automated coverage is in `dashboard/src/` beside each component.
