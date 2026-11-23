// Only this fixed supervisor is interpreted by sh. The user's command remains a separate argv in runner.
// Keep the watchdog until output reaches EOF, even if the command exited leaving descendants on the pipe.
export const RUNNER_SHELL = `
dir=$(mktemp -d) || exit 1
trap 'rm -rf "$dir"' EXIT
mkfifo "$dir/output" || exit 1
shell=sh
if [ -x /bin/bash ]; then shell=/bin/bash; elif command -v bash >/dev/null 2>&1; then shell=bash; fi
cat "$dir/output" & drain=$!
setsid "$shell" -c -- "$0" </dev/null >"$dir/output" 2>&1 & pid=$!
exec 3<&0
(IFS= read -r _ <&3; kill -KILL "$pid"; kill -KILL "-$pid"; kill "$drain") >/dev/null 2>&1 & watch=$!
wait "$pid"; status=$?
wait "$drain"
kill "$watch" 2>/dev/null
wait "$watch" 2>/dev/null
exit "$status"`;
