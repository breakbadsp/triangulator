# Source after installing the AlmaLinux toolchain.
export CXX=c++
if [[ "$ALMA_VERSION" == 8 || "$ALMA_VERSION" == 9 ]]; then
    export PATH="/opt/test/bin:$PATH"
    export CXX=/opt/rh/gcc-toolset-14/root/usr/bin/g++
fi
