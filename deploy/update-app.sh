#!/bin/bash
# A bounded update of the dedicated BBPoker host. No package/runtime upgrades.
# Run from a verified fresh release; all public writes are blocked during migration.
set -euo pipefail
umask 077
die() { echo "$*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || die 'Run as root on the target BBPoker server.'
[[ $# -le 1 ]] || die 'Optional argument: absolute private prepared-administrator proposal path.'
admin_proposal="${1:-}"
if [[ -n $admin_proposal ]]; then
  [[ $admin_proposal == /* && -f $admin_proposal && ! -L $admin_proposal ]] || die 'Administrator proposal must be a private regular file at an absolute path.'
fi
release_dir="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
[[ $release_dir =~ ^/opt/bbpoker/releases/[A-Za-z0-9._-]+$ ]] || die 'Extract into a fresh release directory first.'
[[ -f $release_dir/SHA256SUMS && -f $release_dir/server.js ]] || die 'Reviewed release manifest is missing.'
exec 9>/run/lock/bbpoker-deploy.lock
flock -n 9 || die 'Another BBPoker deployment is running.'
(cd "$release_dir" && sha256sum --check --status SHA256SUMS) || die 'Release checksum failed.'
[[ -L /opt/bbpoker/current ]] || die 'Existing current-release symlink is required.'
previous_current="$(readlink -f /opt/bbpoker/current)"
[[ $previous_current =~ ^/opt/bbpoker/releases/[A-Za-z0-9._-]+$ && $previous_current != "$release_dir" ]] || die 'Expected a distinct previous release.'
[[ ! -L /var/lib/bbpoker && ! -L /etc/bbpoker ]] || die 'Refusing symbolic-link data/config directories.'
for item in /var/lib/bbpoker/table.enc /var/lib/bbpoker/key /etc/bbpoker/app.env; do
  [[ -f $item && ! -L $item ]] || die 'Existing regular data, key and configuration files are required.'
done
node_bin=/opt/bbpoker/runtime/bin/node
[[ -x $node_bin ]] || die 'Existing Node runtime is missing.'
"$node_bin" --check "$release_dir/server.js"
"$node_bin" --check "$release_dir/deploy/verify-snapshot.mjs"
"$node_bin" --check "$release_dir/deploy/activate-prepared-admin.mjs"
while IFS= read -r -d '' source_file; do "$node_bin" --check "$source_file"; done < <(find "$release_dir/src" -type f \( -name '*.js' -o -name '*.mjs' \) -print0)
"$node_bin" --input-type=module - "$release_dir/package.json" <<'NODE'
import { readFileSync } from 'node:fs';
if (JSON.parse(readFileSync(process.argv[2], 'utf8')).version !== '0.25.6') process.exit(1);
NODE
if [[ -n $admin_proposal ]]; then
  "$node_bin" "$release_dir/deploy/activate-prepared-admin.mjs" --data-dir /var/lib/bbpoker --env-file /etc/bbpoker/app.env --proposal "$admin_proposal" --validate-only
fi
systemctl is-active --quiet bbpoker.service || die 'Expected the existing app to be running; inspect privately before updating.'
systemctl is-active --quiet caddy.service || die 'Expected Caddy to be running; inspect privately before updating.'

assert_idle() {
  # Import the old storage reader: never print account records, cards or key material.
  "$node_bin" --input-type=module - "$previous_current/src/store.js" "$release_dir/deploy/verify-snapshot.mjs" <<'NODE'
import { pathToFileURL } from 'node:url';
try {
  const { EncryptedStore } = await import(pathToFileURL(process.argv[2]));
  const { restartBlocker } = await import(pathToFileURL(process.argv[3]));
  const store = new EncryptedStore('/var/lib/bbpoker');
  const blocked = restartBlocker(store.data);
  if (blocked) { console.error(blocked); process.exit(2); }
} catch { console.error('Unable to check the existing saved data safely.'); process.exit(1); }
NODE
}
assert_idle

caddy_stopped=0; app_stopped=0; restore_needed=0; committed=0; snapshot=''
finish() {
  local code=$? recovery_ok=1
  trap - EXIT
  if [[ $code != 0 && $restore_needed == 1 && $committed == 0 ]]; then
    if systemctl stop bbpoker.service; then
      cp -a -- "$snapshot/table.enc" /var/lib/bbpoker/table.enc || recovery_ok=0
      cp -a -- "$snapshot/key" /var/lib/bbpoker/key || recovery_ok=0
      if [[ -d $snapshot/avatars ]]; then
        cp -a -- "$snapshot/avatars" /var/lib/bbpoker/ || recovery_ok=0
      fi
      cp -a -- "$snapshot/app.env" /etc/bbpoker/app.env || recovery_ok=0
      ln -sfnT -- "$previous_current" /opt/bbpoker/current || recovery_ok=0
      if [[ $recovery_ok == 1 ]]; then
        systemctl start bbpoker.service || recovery_ok=0
        app_stopped=0
      fi
    else
      recovery_ok=0
    fi
    if [[ $recovery_ok == 1 ]]; then
      echo 'Update failed before public reopening. Previous program and matching data/config restored.' >&2
    else
      echo 'Rollback requires operator attention. Caddy remains stopped to protect data.' >&2
    fi
  elif [[ $code != 0 && $app_stopped == 1 ]]; then
    systemctl start bbpoker.service || recovery_ok=0
  fi
  if [[ $caddy_stopped == 1 && $recovery_ok == 1 ]]; then
    if ! systemctl start caddy.service; then
      echo 'Caddy could not restart; inspect privately. Do not restore data after public reopening was attempted.' >&2
      code=1
    fi
  fi
  exit "$code"
}
trap finish EXIT
# This host is dedicated to BBPoker. Stopping Caddy closes public connections,
# preventing registration/gameplay writes from being lost by a failed migration.
caddy_stopped=1
systemctl stop caddy.service
if systemctl is-active --quiet caddy.service; then die 'Public entry did not stop; update refused.'; fi
app_stopped=1
systemctl stop bbpoker.service
if systemctl is-active --quiet bbpoker.service; then die 'Application did not stop; update refused.'; fi
# Recheck after both stops: a hand may have started after the first check.
assert_idle
install -d -o root -g root -m 0700 /var/backups/bbpoker-deploy
snapshot="$(mktemp -d /var/backups/bbpoker-deploy/account-upgrade-XXXXXXXX)"
cp -a -- /var/lib/bbpoker/table.enc "$snapshot/table.enc"
cp -a -- /var/lib/bbpoker/key "$snapshot/key"
cp -a -- /etc/bbpoker/app.env "$snapshot/app.env"
if [[ -d /var/lib/bbpoker/avatars && ! -L /var/lib/bbpoker/avatars ]]; then
  cp -a -- /var/lib/bbpoker/avatars "$snapshot/avatars"
fi
printf '%s\n' "$previous_current" > "$snapshot/previous-release.txt"
restore_needed=1
verification_args=()
if [[ -n $admin_proposal ]]; then
  # Copy into the root-only snapshot and use that immutable-for-this-deploy
  # proposal for both activation and independent verification. Never put it
  # inside the release, which becomes world-readable below.
  install -o root -g root -m 0600 -- "$admin_proposal" "$snapshot/prepared-admin.json"
  "$node_bin" "$release_dir/deploy/activate-prepared-admin.mjs" --data-dir /var/lib/bbpoker --env-file /etc/bbpoker/app.env --proposal "$snapshot/prepared-admin.json"
  verification_args=("$snapshot/prepared-admin.json")
fi
chown -R root:root "$release_dir"
chmod -R a+rX "$release_dir"
ln -sfnT -- "$release_dir" /opt/bbpoker/current
systemctl start bbpoker.service
app_stopped=0
healthy=0
for ((attempt=0; attempt<20; attempt++)); do
  if systemctl is-active --quiet bbpoker.service && \
    curl --fail --silent --max-time 2 http://127.0.0.1:8787/api/health | \
      python3 -c 'import json,sys; h=json.load(sys.stdin); sys.exit(0 if h.get("ok") is True and h.get("version")=="0.25.6" else 1)' 2>/dev/null; then
    healthy=1; break
  fi
  sleep 0.5
done
[[ $healthy == 1 ]] || die 'Upgraded local health check failed; restore follows before public reopening.'
listeners="$(ss -H -lnt 'sport = :8787')"
[[ -n $listeners ]] || die 'Application listener missing.'
awk '$4 != "127.0.0.1:8787" {bad=1} END {exit bad}' <<< "$listeners" || die 'Application listener is not loopback-only.'
if [[ -d $snapshot/avatars ]]; then
  diff -qr -- "$snapshot/avatars" /var/lib/bbpoker/avatars >/dev/null || die 'Existing avatar files unexpectedly changed.'
fi
cmp -s -- "$snapshot/key" /var/lib/bbpoker/key || die 'Encryption key unexpectedly changed.'
if [[ -z $admin_proposal ]]; then
  cmp -s -- "$snapshot/app.env" /etc/bbpoker/app.env || die 'Configuration unexpectedly changed.'
fi
BBPOKER_VERIFY_ENV_FILE=/etc/bbpoker/app.env "$node_bin" "$release_dir/deploy/verify-snapshot.mjs" "$snapshot" /var/lib/bbpoker "${verification_args[@]}"
# Once Caddy may accept clients, rolling back this snapshot could lose their writes.
committed=1
systemctl start caddy.service
systemctl is-active --quiet caddy.service || die 'App upgraded, but Caddy needs recovery. Data rollback is disabled.'
caddy_stopped=0
echo 'BBPoker 0.25.6 is running. Existing records/key preserved; only explicitly requested administrator configuration may differ. Public entry reopened.'
echo "Private pre-upgrade snapshot: $snapshot (same disk, not disaster recovery)."
echo 'Now perform HTTPS account and gameplay acceptance; retain the snapshot privately.'
