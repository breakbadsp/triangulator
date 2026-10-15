# Dashboard contextual help

Help lets users interpret observations without leaving the dashboard. Keep
units, scope, time range, and missing or stale status visible. Optional
implementation detail belongs in help.

Use one topic for a short explanation and its detailed guide. Keep topic text,
examples, measurement limits, and related topics in
[dashboard.html](../collector/dashboard.html). Do not copy that text into docs.

## Help for new dashboard features

Every user-visible section, card, chart, label, column, legend, and disclosure
needs a contextual help topic in the same change. Reuse a topic when its meaning
and scope are the same. Explain unavailable data and sampling limits explicitly.

Use the shared help controls. Keep hover help dismissible and readable when the
pointer enters it. Provide keyboard and touch access through information buttons.
Chart guides need a text explanation and a data table where applicable.
Do not let help change sorting, selection, or keyboard focus.

Update [dashboard_test.js](../tests/dashboard_test.js) for topic coverage.
Use the [manual browser checks](manual-qa.md) for interaction, viewport, and
accessibility behavior that DOM tests cannot establish.

The interaction model follows
[W3C guidance for content on hover or focus](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html).
