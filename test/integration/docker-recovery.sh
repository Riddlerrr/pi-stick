#!/usr/bin/env bash
# Run from the checkout root. No operator projects, Pi settings or model tokens are used.
set -euo pipefail
[[ $(id -u) != 0 ]] || { echo 'Run as a non-root user with Docker access' >&2; exit 1; }
docker info >/dev/null
docker compose version
root=$(pwd)
tmp=$(mktemp -d)
tag=$(node -p 'crypto.randomUUID()')
export PI_STICK_IMAGE="pi-stick-recovery:$tag" PI_STICK_DEV_HOME="$tmp/dev"
runner="pi-stick-recovery-runner:$tag"
export DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"
export HOME="$tmp/home" PATH="$tmp/bin:$PATH"
unset PI_STICK_HOME
mkdir -p "$HOME/.pi/agent" "$tmp/bin" "$tmp/repo"
cli="$root/pistick-dev"
run= key= pid=
cleanup() {
  local rc=$?
  set +e
  if ((rc)) && [[ -f $tmp/cli.log ]]; then tail -n 100 "$tmp/cli.log" >&2; fi
  if [[ -n $pid ]]; then kill "$pid" 2>/dev/null; fi
  if [[ -z $run ]]; then
    for d in "$PI_STICK_DEV_HOME"/state/runs/*; do [[ -d $d ]] && run=$d; done
  fi
  if [[ -n $run ]]; then
    local id=${run##*/}; key="pi-stick-demo-${id:0:12}"
    if ((rc)); then tail -n 100 "$run/worker.log" "$run/progress" "$run/scratch/requests" >&2; fi
    for c in $(docker ps -q --filter "network=${key}_default" --filter "ancestor=$PI_STICK_IMAGE"); do docker rm -f "$c" >/dev/null; done
    if [[ -f $run/compose.yaml ]]; then docker compose -p "$key" -f "$run/compose.yaml" down --volumes; fi
  fi
  docker image rm "$runner" "$PI_STICK_IMAGE" >/dev/null 2>&1
  rm -rf -- "$tmp"
  exit "$rc"
}
trap cleanup EXIT

docker build -q -t "$PI_STICK_IMAGE" .
printf '#!/bin/sh\nprintf "fixture-token\\n"\n' > "$tmp/bin/pi"
chmod +x "$tmp/bin/pi"
cat > "$HOME/.pi/agent/models-store.json" <<'JSON'
{"groq":{"models":[{"provider":"groq","id":"recovery-test","name":"Recovery fixture","api":"openai-completions","baseUrl":"http://runner:8123/v1","input":["text"],"reasoning":false,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":32768,"maxTokens":1024}]}}
JSON
cp test/integration/model.mjs "$tmp/repo/"
git -C "$tmp/repo" init -q
git -C "$tmp/repo" add model.mjs
git -C "$tmp/repo" -c user.name=Fixture -c user.email=fixture@localhost commit -qm fixture
"$cli" create project demo --repo "$tmp/repo"
project="$PI_STICK_DEV_HOME/projects/demo"
printf 'FROM %s\nCOPY --chmod=755 setup-project /usr/local/bin/\n' "$PI_STICK_IMAGE" > "$project/Dockerfile"
cat > "$project/compose.yaml" <<YAML
services:
  runner:
    image: $runner
    build: .
    pull_policy: build
    user: "$(id -u):$(id -g)"
    command: [node, /workspace/repo/model.mjs]
    volumes: [source:/workspace]
    healthcheck:
      test: [CMD, node, -e, "fetch('http://localhost:8123/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 1s
      timeout: 3s
      retries: 15
volumes:
  source:
YAML
mkdir -p "$PI_STICK_DEV_HOME/actions/recover"
cat > "$PI_STICK_DEV_HOME/actions/recover/action.json" <<'JSON'
{"model":"groq/recovery-test","orchestrator":{"tools":[]},"agents":{"worker":{"mode":"read-write","tools":[]}},"stages":[{"name":"first","parallel":["worker"],"prompt":"stage-A"},{"name":"second","parallel":["worker"],"prompt":"stage-B"}]}
JSON

interrupt() {
  local step=$1; shift
  timeout 180 "$cli" "$@" > "$tmp/cli.log" 2>&1 & pid=$!
  local deadline=$((SECONDS+150))
  until [[ -n $run && -f $run/scratch/requests ]] && grep -qxF "$step" "$run/scratch/requests"; do
    for d in "$PI_STICK_DEV_HOME"/state/runs/*; do [[ -d $d ]] && run=$d; done
    if ! kill -0 "$pid" 2>/dev/null || ((SECONDS >= deadline)); then echo "Did not reach $step" >&2; return 1; fi
    sleep 0.1
  done
  id=${run##*/}; key="pi-stick-demo-${id:0:12}"
  # Match the exact image (runner derives from it) and only this run's network.
  local agent
  agent=$(docker ps --filter "network=${key}_default" --format '{{.ID}} {{.Image}}' | awk -v img="$PI_STICK_IMAGE" '$2==img {print $1}')
  [[ $agent =~ ^[0-9a-f]+$ ]]
  docker kill "$agent" >/dev/null
  local rc=0; wait "$pid" || rc=$?; pid=
  [[ $rc == 1 ]]
}
assert_stopped() {
  local c
  c=$(docker compose -p "$key" -f "$run/compose.yaml" ps -aq runner)
  [[ -n $c && $(docker inspect -f '{{.State.Status}}' "$c") == exited ]]
}
interrupt B run demo recover 'initial task'
assert_stopped
timeout 90 "$cli" resume "$id"
[[ $(<"$run/report.md") == 'initial report' ]]
[[ $(<"$run/outputs/worker.md") == $'result-A\n\n---\n\nresult-B' ]]
assert_stopped
interrupt follow-up continue "$id" follow-up
assert_stopped
timeout 90 "$cli" resume "$id"
[[ $(<"$run/report.md") == 'continued report' ]]
[[ $(<"$run/scratch/requests") == $'A\nB\nB\nroot\nfollow-up\nfollow-up' ]]
assert_stopped
printf '\n// inspected after stack stop\n' >> "$run/workspace/repo/model.mjs"
touch "$run/workspace/repo/new-file"
diff_output=$("$cli" diff "$id")
[[ $diff_output == *'+// inspected after stack stop'* && $diff_output == *'  new-file'* ]]
echo 'Docker recovery and isolated Git inspection passed.'
