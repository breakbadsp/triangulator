# Dashboard source help

Info buttons stay visible in a light color at the top-right of their help area.
Reserve space so they do not cover text or controls. Open help only on request.

Keep a brief description and the source: file, field, reader, and calculation.
Keep source details in `dashboard/src/help/topics.ts`. Do not add examples,
reading guides, related topics, or copies of chart data.

## Help for new dashboard features

Add a source topic for each new measurement. Controls need only a short
description. Reuse existing topics. Keep keyboard and touch access, Escape,
focus return, and native-dialog support. Update [manual cases](qa/test-cases.md).
