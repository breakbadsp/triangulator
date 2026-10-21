# Demo graphics

Animated SVG graphics for demos and talks. Open each file in a browser to see
the animation.

| File | Shows |
| --- | --- |
| [architecture.svg](architecture.svg) | How a thread sample travels from the target to the dashboard. Copy of `docs/assets/architecture.svg`. |
| [sampling-rates.svg](sampling-rates.svg) | Default sampling and refresh rate of each section, on one 30 s timeline. |
| [benchmarks.svg](benchmarks.svg) | Sampler cost, C++ against Python collector, and the cost of slower samples. Numbers from `docs/sampler-benchmark.json`, `docs/collector-comparison.md`, and `docs/target-impact.md`. |
| [performance.svg](performance.svg) | Collector benchmark summary. Copy of `docs/assets/performance.svg`. |
| [constraints.svg](constraints.svg) | The sampler rules, the two known exceptions, and the split between core and separate programs. |

The rates are defaults. A local `sampler.toml` or `collector.toml` can set other
values. See [setup](../setup.md) and [target impact](../target-impact.md).
