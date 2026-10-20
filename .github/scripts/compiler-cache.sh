# Source after selecting Python and the compiler in a build container.
# /cache is persistent on local runners, or restored by actions/cache on GitHub.
if [[ -d /cache ]]; then
    python3 .github/scripts/install-compiler-cache.py /cache /opt/ci/bin
    export COMPILER_CACHE=/opt/ci/bin/ccache
    export CCACHE_DIR=/cache/objects
    export CCACHE_COMPILERCHECK=content
    export CCACHE_MAXSIZE=512M
    export CCACHE_UMASK=0022
    # Each container has a separate log, even when slots share cached objects.
    export CCACHE_STATSLOG=/tmp/triangulator-ccache-stats.log
    rm -f "$CCACHE_STATSLOG"
fi
