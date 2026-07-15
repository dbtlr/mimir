# Operator guides

Recipes for running a `mimir` install day to day: the launchd service
lifecycle, health probing, self-update, port/proxy posture, and where the
binary should live. Each page is self-contained — read the one you need.

| Guide                                       | Covers                                                               |
| ------------------------------------------- | -------------------------------------------------------------------- |
| [Service lifecycle](service-lifecycle.md)   | `install` / `uninstall` / `start` / `stop` / `restart` under launchd |
| [Health probing](health-probing.md)         | What `/api/health` does and doesn't tell you; reading a 409          |
| [Self-update](self-update.md)               | `mimir self-update`'s channels, verification, and restart behavior   |
| [Port and proxy posture](port-and-proxy.md) | Port precedence, why the plist never bakes a port, proxy boundary    |
| [Install location](install-location.md)     | Why the binary belongs at `~/.local/bin`, not a network volume       |

A recipe worth keeping lands as a direct edit to one of these pages in the PR
that discovers it (or a stub here if it isn't fully statable yet) — a recipe
parked for later tends to rot instead of landing.
