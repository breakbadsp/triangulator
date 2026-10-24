ARG ALMA_VERSION=8
FROM almalinux:${ALMA_VERSION}
ARG ALMA_VERSION
COPY almalinux-toolchain.sh install-node.sh /tmp/
RUN bash /tmp/almalinux-toolchain.sh && rm /tmp/almalinux-toolchain.sh /tmp/install-node.sh
