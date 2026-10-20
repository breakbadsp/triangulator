# Source after selecting Python and the compiler in a build container.
# /cache is a job-local directory restored and saved by actions/cache.
if [[ -d /cache ]]; then
    python3 .github/scripts/install-compiler-cache.py /cache /opt/ci/bin
    export COMPILER_CACHE=/opt/ci/bin/ccache
    export CCACHE_DIR=/cache/objects
    export CCACHE_COMPILERCHECK=content
    export CCACHE_MAXSIZE=512M
    export CCACHE_UMASK=0022
    "$COMPILER_CACHE" --zero-stats
fi
