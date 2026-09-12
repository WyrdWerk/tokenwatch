#!/usr/bin/env bash
set -euo pipefail

# Start one isolated, loopback-only bb instance for the current Amp thread.
# AMP_THREAD_ID is part of the data path so restarts reuse state without sharing
# a database across threads. Setup never starts this process.
umask 077

readonly BB_VERSION="0.43.0"
readonly BB_RUNTIME="${HOME}/.local/share/bb-pilot/runtime"
readonly BB_APP="${BB_RUNTIME}/node_modules/.bin/bb-app"
readonly BB_DATA_ROOT="${HOME}/.local/share/bb-pilot/data"
readonly BB_DAEMON_PORT_MIN=49152
readonly BB_DAEMON_PORT_SPAN=16384

: "${PORT:?Amp must provide PORT for the bb HTTP listener}"
: "${AMP_THREAD_ID:?Amp must provide AMP_THREAD_ID for bb isolation}"

if [[ ! "${AMP_THREAD_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ || "${AMP_THREAD_ID}" == "." || "${AMP_THREAD_ID}" == ".." ]]; then
  printf 'bb service: unsafe AMP_THREAD_ID\n' >&2
  exit 1
fi
if [[ ! "${PORT}" =~ ^[0-9]+$ || "${PORT}" -lt 1 || "${PORT}" -gt 65535 ]]; then
  printf 'bb service: invalid Amp PORT\n' >&2
  exit 1
fi

readonly BB_HOST_DAEMON_PORT="$((BB_DAEMON_PORT_MIN + PORT % BB_DAEMON_PORT_SPAN))"
if [[ "${PORT}" == "${BB_HOST_DAEMON_PORT}" ]]; then
  printf 'bb service: HTTP and host-daemon ports must differ\n' >&2
  exit 1
fi

# Amp assigns each declared service an HTTP PORT. Derive a stable companion
# daemon port in a separate range so a restart reuses the same port. Refuse a
# collision rather than appearing healthy against another thread's state.
# Amp orb-forwarding on 169.254/16 is ignored; only loopback/wildcard counts.
command -v ss >/dev/null || {
  printf 'bb service: ss is required for daemon port collision checks\n' >&2
  exit 1
}
if ss -H -ltn "sport = :${BB_HOST_DAEMON_PORT}" 2>/dev/null \
  | awk '$4 ~ /^127\.0\.0\.1:/ || $4 ~ /^0\.0\.0\.0:/ || $4 ~ /^\*:/ || $4 ~ /^\[::/ { found = 1 } END { exit !found }'; then
  printf 'bb service: host-daemon port %s is already in use\n' "${BB_HOST_DAEMON_PORT}" >&2
  exit 1
fi

[[ -x "${BB_APP}" ]] || {
  printf 'bb service: bb-app is not installed; run .agents/setup first\n' >&2
  exit 1
}
[[ -f "${BB_RUNTIME}/.bb-pilot-managed" ]] || {
  printf 'bb service: refusing unowned runtime at %s\n' "${BB_RUNTIME}" >&2
  exit 1
}
[[ "$("${BB_RUNTIME}/node_modules/.bin/bb" --version)" == "${BB_VERSION}" ]] || {
  printf 'bb service: expected bb-app %s\n' "${BB_VERSION}" >&2
  exit 1
}

for path in "${BB_DATA_ROOT}" "${BB_DATA_ROOT}/${AMP_THREAD_ID}"; do
  [[ ! -L "${path}" ]] || {
    printf 'bb service: refusing symlink data path\n' >&2
    exit 1
  }
  mkdir -p "${path}"
  chmod 700 "${path}"
done

if find "${BB_DATA_ROOT}/${AMP_THREAD_ID}" -type l -print -quit | grep -q .; then
  printf 'bb service: symlink in thread state\n' >&2
  exit 1
fi
find "${BB_DATA_ROOT}/${AMP_THREAD_ID}" -type d -exec chmod 700 {} +
find "${BB_DATA_ROOT}/${AMP_THREAD_ID}" -type f -exec chmod 600 {} +

export BB_TELEMETRY=false
export BB_SERVER_BIND_HOST=127.0.0.1
export BB_DATA_DIR="${BB_DATA_ROOT}/${AMP_THREAD_ID}"
export BB_SERVER_PORT="${PORT}"
export BB_HOST_DAEMON_PORT

# Do not pass plugin enable/disable arguments. Clean thread state uses upstream
# 0.43.0 defaults (27 bundled / 20 enabled / 7 default-off).
exec "${BB_APP}" \
  --data-dir "${BB_DATA_DIR}" \
  --server-bind-host 127.0.0.1 \
  --server-port "${PORT}" \
  --host-daemon-port "${BB_HOST_DAEMON_PORT}"
