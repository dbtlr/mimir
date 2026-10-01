# A disposable Linux host with systemd as PID 1 and one lingering non-root
# user, for `bun run sandbox service-verify --target container` (MMR-54).
FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl dbus dbus-user-session git systemd systemd-sysv xz-utils \
  && rm -rf /var/lib/apt/lists/*

# The serve unit's install preflight requires norn (ADR 0018). Same pin and
# digests as ci.yml; bump them together.
ARG NORN_VERSION=v0.48.0
RUN set -eu; \
  case "$(uname -m)" in \
    x86_64) target=x86_64-unknown-linux-musl; sha256=9985e026e7974b00ed20fceb964f18265b57e393dbd798a9d4a6df8974cac165 ;; \
    aarch64) target=aarch64-unknown-linux-musl; sha256=f3c7adf0af86fd1f449cbab147bc507ba5312c1f113805cb67efb46fb1f2fc8e ;; \
    *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
  esac; \
  cd /tmp; \
  curl -fsSLO "https://github.com/dbtlr/norn/releases/download/${NORN_VERSION}/norn-run-${target}.tar.xz"; \
  echo "${sha256}  norn-run-${target}.tar.xz" | sha256sum -c; \
  tar -xf "norn-run-${target}.tar.xz"; \
  install -m 0755 "norn-run-${target}/norn" /usr/local/bin/norn; \
  rm -rf /tmp/norn-run-*

# A lingering user gets a systemd --user manager at boot, without a login.
RUN useradd --create-home --shell /bin/bash mimir \
  && mkdir -p /var/lib/systemd/linger \
  && touch /var/lib/systemd/linger/mimir

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
