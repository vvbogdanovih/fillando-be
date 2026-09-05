#!/usr/bin/env bash
#
# Rehearses the catalogue migration chain against a production dump, in the disposable
# MongoDB from docker-compose.test.yml. Nothing here can touch the real database: the URI is
# hard-coded to the test container on 127.0.0.1:27018, and `DATABASE_URL` is passed to every
# script explicitly, which `dotenv` does not override.
#
# Only the catalogue collections are restored. The dump also holds users, orders, carts and
# refresh tokens; none of them matter to these migrations, and not restoring them keeps real
# customer data out of the rehearsal entirely.
#
# Usage:
#   scripts/fillando_v_2/rehearse-on-dump.sh [path-to-dump-root] [--keep]
#
#   path-to-dump-root  directory holding the mongodump database folder
#                      (default: ~/Desktop/db_backup_for_test)
#   --keep             leave the container running afterwards so the result can be inspected
#
# Exit code is non-zero if any step of the chain fails.

set -euo pipefail

cd "$(dirname "$0")/../.."

DUMP_ROOT="${1:-$HOME/Desktop/db_backup_for_test}"
[[ "${1:-}" == --* ]] && DUMP_ROOT="$HOME/Desktop/db_backup_for_test"
KEEP=false
for arg in "$@"; do [[ "$arg" == "--keep" ]] && KEEP=true; done

TEST_URI="mongodb://127.0.0.1:27018"
TARGET_DB="rehearsal"
COLLECTIONS=(categories vendors products product_variants colors landings)

if [[ ! -d "$DUMP_ROOT" ]]; then
	echo "Dump not found: $DUMP_ROOT" >&2
	exit 1
fi

# The dump root holds one directory named after the source database.
SOURCE_DB="$(find "$DUMP_ROOT" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | head -1)"
if [[ -z "$SOURCE_DB" ]]; then
	echo "No database directory inside $DUMP_ROOT" >&2
	exit 1
fi

command -v mongorestore >/dev/null || { echo "mongorestore is not installed" >&2; exit 1; }

echo "══════════════════════════════════════════════════════════════════════════════"
echo "Rehearsal: $SOURCE_DB → $TEST_URI/$TARGET_DB"
echo "Restoring only: ${COLLECTIONS[*]}"
echo "══════════════════════════════════════════════════════════════════════════════"

docker compose -f docker-compose.test.yml up -d --wait >/dev/null
echo "Test MongoDB is up."

NS_ARGS=()
for c in "${COLLECTIONS[@]}"; do NS_ARGS+=(--nsInclude="$SOURCE_DB.$c"); done

mongorestore \
	--uri="$TEST_URI" \
	--drop \
	--quiet \
	--nsFrom="$SOURCE_DB.*" \
	--nsTo="$TARGET_DB.*" \
	"${NS_ARGS[@]}" \
	"$DUMP_ROOT" 2>&1 | grep -vE '^$' || true

echo "Restored."
echo

# Reports from a rehearsal must never be mistaken for a real run, so they are written into a
# throwaway directory instead of scripts/fillando_v_2/reports/.
REPORTS="$(mktemp -d)/reports"
mkdir -p "$REPORTS"

export DATABASE_URL="$TEST_URI/$TARGET_DB"
export MIGRATION_REPORT_DIR="$REPORTS"

echo "──────────────────────────── state before ────────────────────────────"
node scripts/fillando_v_2/verify-catalog-state.js || true

echo
echo "──────────────────────────── running the chain ────────────────────────────"
STATUS=0
node scripts/fillando_v_2/run-all.js --include-colors --yes || STATUS=$?

echo
echo "──────────────────────────── state after ────────────────────────────"
node scripts/fillando_v_2/verify-catalog-state.js || STATUS=$?

echo
echo "──────────────────────────── convergence check ────────────────────────────"
echo "Every step below must report that it has nothing to do."
node scripts/fillando_v_2/run-all.js --dry-run --include-colors 2>&1 |
	grep -E '^\[[0-9]|Nothing to do|Plan:|Would' | grep -v 'expect:' || true

echo
echo "Rehearsal reports: $REPORTS"

if [[ "$KEEP" == true ]]; then
	echo "Container left running. Inspect with DATABASE_URL=$DATABASE_URL, then:"
	echo "  yarn test:db:down"
else
	docker compose -f docker-compose.test.yml down -v >/dev/null 2>&1
	echo "Container removed."
fi

exit $STATUS
