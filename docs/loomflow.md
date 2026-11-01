# LoomFlow

Use the [shared LoomFlow specification](https://github.com/breakbadsp/ai-assets/blob/main/docs/loomflow.md). The local copy is `$HOME/ai/docs/loomflow.md`.

After cloning Triangulator on any machine, run `bash scripts/setup-ai.sh`
from the repository root. This needs Bash, Git, and access to the ai-assets
repository. The LoomFlow entry command also runs setup before each session.
Setup updates `~/ai` to the latest `main`, installs the shared files, checks
the references, and reports the commit used. If setup fails, resolve the
reported error and run it again before starting LoomFlow.
