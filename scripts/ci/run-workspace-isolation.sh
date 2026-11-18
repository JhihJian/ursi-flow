#!/usr/bin/env bash
# Run from any directory, against the current (possibly uncommitted) working tree.
set -euo pipefail
usage() { echo "usage: $0 server|sandbox [--check-only]" >&2; exit 2; }
[[ $# == 1 || ( $# == 2 && $2 == --check-only ) ]] || usage
case ${1:-} in
  server) paths=(Cargo.toml Cargo.lock server); workspace=. ;;
  sandbox) paths=(ursi-sandbox); workspace=ursi-sandbox ;;
  *) usage ;;
esac
side=$1
cd "$(dirname "$0")/../.."
repo=$PWD
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ursi-$side.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
if [[ ${2:-} != --check-only ]]; then
  report=${CI_REPORT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/ursi-$side-report.XXXXXX")}
  mkdir -p "$report"
  report=$(realpath "$report")
  printf 'Report: %s\n' "$report"
fi
mkdir "$scratch/src"
for config in .cargo rust-toolchain rust-toolchain.toml; do
  if [[ -e $config ]]; then paths+=("$config"); fi
done
rsync -a --exclude=target/ --exclude=.git/ "${paths[@]}" "$scratch/src/"
if [[ $side == server ]]; then
  rsync -aR flow-runtime/client/{Cargo.toml,Cargo.lock,src} "$scratch/src/"
else
  contract=${URSI_GATEWAY_V1_CONTRACT_DIR:-$repo/contracts/gateway/v1}
  mkdir "$scratch/contract"
  rsync -a "$contract/" "$scratch/contract/"
  export URSI_GATEWAY_V1_CONTRACT_DIR=$scratch/contract
  test -s "$URSI_GATEWAY_V1_CONTRACT_DIR/openapi.yaml"
fi
check_symlinks() {
  if find "$1" -type l -print -quit | grep -q .; then
    echo 'isolation inputs may not contain symlinks' >&2; exit 1
  fi
}
check_symlinks "$scratch"
export CARGO_TARGET_DIR=$scratch/target CARGO_INCREMENTAL=0
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
cd "$scratch/src"
python3 "$repo/scripts/ci/check-workspace-isolation.py" "$side"
if [[ ${2:-} == --check-only ]]; then exit 0; fi
cd "$workspace"
status=0
summary="$report/summary.txt"
printf '%s\n' "$side (counts from executed test binaries)" > "$summary"
run_suite() {
  local name=$1; shift
  cargo build --locked "$@"
  local suite log
  for suite in all-targets doc; do
    log="$report/$name-$suite.log"
    cargo test --locked --no-fail-fast "$@" "--$suite" 2>&1 | tee "$log" || status=1
    awk -v label="$name/$suite" '/^test result: (ok|FAILED)\./ {p+=$4; f+=$6; i+=$8; n++}
      END {printf "%s: %d passed, %d failed, %d ignored (%d harnesses)\n",label,p,f,i,n}' \
      "$log" >> "$summary"
  done
}
run_suite workspace --workspace --all-features
if [[ $side == server ]]; then
  cargo build --locked --bin ursi-server
  cargo build --locked --manifest-path flow-runtime/client/Cargo.toml --bin ursi-flow
  # Build the daemon separately, after all Rust compilation and doctests.
  mkdir "$scratch/daemon"
  rsync -a "$repo"/flow-runtime/{src,package.json,package-lock.json,tsconfig.json,tsconfig.build.json} "$scratch/daemon/"
  check_symlinks "$scratch/daemon"
  (cd "$scratch/daemon" && npm ci --no-audit --no-fund && npm run build)
  bins=(--server "$CARGO_TARGET_DIR/debug/ursi-server" --cli "$CARGO_TARGET_DIR/debug/ursi-flow"
        --daemon "$scratch/daemon/dist/machine/daemon.js")
  run_e2e() {
    local name=$1; shift
    local log="$report/$name.log"
    python3 -B "$@" 2>&1 | tee "$log" || status=1
    printf '%s:\n' "$name" >> "$summary"
    grep -E '^Ran |^OK|^FAILED' "$log" >> "$summary" || status=1
  }
  run_e2e server-e2e server/tests/runtime_e2e.py "${bins[@]}"
  run_e2e work-flow server/tests/work_e2e.py --stage flow "${bins[@]}"
  # Install outside the workspace and select this CLI even if PATH contains another pi.
  npm install --global --prefix "$scratch/pi" --no-audit --no-fund @earendil-works/pi-coding-agent@1.5.2
  "$scratch/pi/bin/pi" --version
  run_e2e work-agent server/tests/work_e2e.py --stage agent "${bins[@]}" --pi "$scratch/pi/bin/pi"
else
  for dir in client/scripts runtime/scripts; do
    log="$report/${dir%/*}-python.log"
    python3 -B -m unittest discover -s "$dir" 2>&1 | tee "$log" || status=1
    grep -E '^Ran |^OK|^FAILED' "$log" >> "$summary" || status=1
  done
fi
cat "$summary"
if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then cat "$summary" >> "$GITHUB_STEP_SUMMARY"; fi
exit "$status"
