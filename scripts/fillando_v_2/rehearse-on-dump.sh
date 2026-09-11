#!/usr/bin/env bash
# Restore only catalogue data into a NEW disposable container. Never reuse the test DB.
set -euo pipefail
cd "$(dirname "$0")/../.."
DUMP_ROOT=""
KEEP=false
for arg in "$@"; do
 case "$arg" in
  --keep) KEEP=true ;;
  --*) echo "Unknown option: $arg" >&2; exit 1 ;;
  *) if [[ -n "$DUMP_ROOT" ]]; then echo 'Expected one dump directory' >&2; exit 1; fi
     DUMP_ROOT="$arg" ;;
 esac
done
DUMP_ROOT="${DUMP_ROOT:-$HOME/Desktop/db_backup_for_test}"
[[ -d "$DUMP_ROOT" ]] || { echo "Dump not found: $DUMP_ROOT" >&2; exit 1; }
for tool in docker mongorestore node; do
 command -v "$tool" >/dev/null || { echo "$tool is not installed" >&2; exit 1; }
done
# Accept the database directory itself or an unambiguous mongodump root.
if [[ -f "$DUMP_ROOT/products.bson" ]]; then
 SOURCE_DIR="$DUMP_ROOT"
else
 SOURCES=()
 for dir in "$DUMP_ROOT"/*; do
  [[ -d "$dir" && -f "$dir/products.bson" ]] && SOURCES+=("$dir")
 done
 [[ ${#SOURCES[@]} -eq 1 ]] || { echo 'Expected exactly one database containing products.bson' >&2; exit 1; }
 SOURCE_DIR="${SOURCES[0]}"
fi
for c in categories products product_variants; do
 [[ -s "$SOURCE_DIR/$c.bson" ]] || { echo "Missing or empty $c.bson" >&2; exit 1; }
done
SOURCE_DB="$(basename "$SOURCE_DIR")"
REPORT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fillando-rehearsal.XXXXXX")"
CONTAINER=""
cleanup() {
 local status=$?
 if [[ -n "$CONTAINER" ]]; then
  if [[ "$KEEP" == true ]]; then
   echo "Container retained: $CONTAINER. Remove after inspection: docker rm -f $CONTAINER"
  else
   docker rm -f "$CONTAINER" >/dev/null || true
  fi
 fi
 echo "Rehearsal reports: $REPORT_ROOT (exit $status)"
}
trap cleanup EXIT
CONTAINER="$(docker run -d --publish 127.0.0.1::27017 --tmpfs /data/db mongo:7)"
READY=false
for attempt in {1..30}; do
 if docker exec "$CONTAINER" mongosh --quiet --eval 'quit(db.adminCommand({ping:1}).ok ? 0 : 1)' >/dev/null 2>&1; then READY=true; break; fi
 sleep 1
done
[[ "$READY" == true ]] || { echo 'Test MongoDB did not start' >&2; exit 1; }
PORT="$(docker port "$CONTAINER" 27017/tcp)"
export DATABASE_URL="mongodb://$PORT/rehearsal"
export MIGRATION_REPORT_DIR="$REPORT_ROOT/reports"
mkdir -p "$MIGRATION_REPORT_DIR"
echo "Rehearsal: $SOURCE_DB → $DATABASE_URL (new isolated container)"
# Never migrate a partial restore. Metadata beside each BSON restores its indexes as well.
for c in categories vendors products product_variants colors landings; do
 if [[ -f "$SOURCE_DIR/$c.bson" ]]; then
  mongorestore --uri="$DATABASE_URL" --db=rehearsal --collection="$c" --stopOnError --quiet "$SOURCE_DIR/$c.bson"
 fi
done
node scripts/fillando_v_2/catalog-snapshot.js "$REPORT_ROOT/before.json"
# Late dry-run steps can refuse dependencies absent before the first apply (e.g. colours).
DRY_STATUS=0
node scripts/fillando_v_2/run-all.js --dry-run --include-colors > "$REPORT_ROOT/dry-run.log" 2>&1 || DRY_STATUS=$?
node scripts/fillando_v_2/catalog-snapshot.js "$REPORT_ROOT/after-dry-run.json"
cmp "$REPORT_ROOT/before.json" "$REPORT_ROOT/after-dry-run.json"
echo "Dry run did not modify data (exit $DRY_STATUS; see dry-run.log)."
node scripts/fillando_v_2/run-all.js --include-colors --yes
node scripts/fillando_v_2/verify-catalog-state.js --complete
node scripts/fillando_v_2/catalog-snapshot.js "$REPORT_ROOT/after.json"
# Compare actual writes on a third pass, not grepped console messages.
node scripts/fillando_v_2/run-all.js --include-colors --single-pass --yes
node scripts/fillando_v_2/catalog-snapshot.js "$REPORT_ROOT/repeated.json"
cmp "$REPORT_ROOT/after.json" "$REPORT_ROOT/repeated.json"
node scripts/fillando_v_2/run-all.js --dry-run --include-colors
echo 'PASS: restore, complete migration, verification, dry-run immutability and repeat-run convergence.'
