# A disposable Linux host with systemd as PID 1 and one lingering non-root
# user, for `bun run sandbox service-verify --target container` (MMR-54).
FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl dbus dbus-user-session systemd systemd-sysv \
  && rm -rf /var/lib/apt/lists/*

# A lingering user gets a systemd --user manager at boot, without a login.
RUN useradd --create-home --shell /bin/bash mimir \
  && mkdir -p /var/lib/systemd/linger \
  && touch /var/lib/systemd/linger/mimir

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
