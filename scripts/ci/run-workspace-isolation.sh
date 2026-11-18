#!/usr/bin/env bash
# Run from any directory, against the current (possibly uncommitted) working tree.
set -euo pipefail
usage() { echo "usage: $0 server|sandbox [--check-only]" >&2; exit 2; }
[[ $# == 1 || ( $# == 2 && $2 == --check-only ) ]] || usage
case ${1:-} in
  server) paths=(Cargo.toml Cargo.lock server flow-core sandbox-access); workspace=. ;;
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
mkdir -p "$scratch/src" "$scratch/contract"
for config in .cargo rust-toolchain rust-toolchain.toml; do
  if [[ -e $config ]]; then paths+=("$config"); fi
done
rsync -a --exclude=target/ --exclude=.git/ "${paths[@]}" "$scratch/src/"
if [[ $side == server ]]; then
  # Cargo reads this parent manifest for workspace inheritance when resolving
  # the external SDK. It does not need to load the other workspace members.
  rsync -aR ursi-sandbox/Cargo.toml ursi-sandbox/client/{Cargo.toml,src} "$scratch/src/"
fi
# Preserve the contract layout, but never expose either product's source in the artifact.
contract=${URSI_GATEWAY_V1_CONTRACT_DIR:-$repo/contracts/gateway/v1}
rsync -a "$contract/" "$scratch/contract/"
if find "$scratch" -type l -print -quit | grep -q .; then
  echo 'isolation inputs may not contain symlinks' >&2; exit 1
fi
export URSI_GATEWAY_V1_CONTRACT_DIR=$scratch/contract
test -s "$URSI_GATEWAY_V1_CONTRACT_DIR/openapi.yaml"
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
  run_suite server-no-default -p ursi-server --no-default-features
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
