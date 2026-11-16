#!/bin/sh
set -eu

fail() {
  echo "Pictelier: $*" >&2
  exit 1
}

# Docker creates a missing bind source as root. Prepare the dedicated data mount,
# then drop privileges before starting the application.
data_dir=$(realpath -ms -- "${DATA_DIR:-/app/data}")
case "$data_dir" in
  /|/app|/app/server|/app/server/*|/app/dist|/app/dist/*|/bin|/bin/*|/sbin|/sbin/*|/etc|/etc/*|/usr|/usr/*|/lib|/lib/*|/lib64|/lib64/*|/boot|/boot/*|/dev|/dev/*|/proc|/proc/*|/sys|/sys/*|/run|/run/*|/var|/var/lib|/opt|/home|/root|/tmp|/mnt|/media)
    fail "DATA_DIR must be a dedicated data directory (current: $data_dir)." ;;
esac
[ "$(realpath -m -- "$data_dir")" = "$data_dir" ] \
  || fail "DATA_DIR contains a symbolic link; mount its real directory directly at /app/data."
export DATA_DIR="$data_dir"

if [ "$(id -u)" = 0 ]; then
  mkdir -p -- "$data_dir" \
    || fail "Cannot create $data_dir. Check the data mount and host filesystem."
  probe=$(mktemp "$data_dir/.pictelier-write-check.XXXXXX") \
    || fail "Data mount is not writable: $data_dir. Use a read-write mount and check the host filesystem."
  rm -f -- "$probe"

  # Do not follow symlinks or cross filesystem boundaries. Existing database,
  # WAL/SHM, media and backups keep their contents and hard-link relationships.
  find -P "$data_dir" -xdev \( -type d -o -type f \) \
    \( ! -user node -o ! -group node \) -exec chown -h node:node -- {} + \
    || fail "Cannot set data ownership. Allow CHOWN and DAC_OVERRIDE, or prepare the mount for UID/GID 1000 and run as that user."
  find -P "$data_dir" -xdev -type d ! -perm -u=rwx -exec chmod u+rwx -- {} + \
    || fail "Cannot set directory permissions. Allow FOWNER, or prepare the mount for UID/GID 1000."
  find -P "$data_dir" -xdev -type f ! -perm -u=rw -exec chmod u+rw -- {} + \
    || fail "Cannot set file permissions. Allow FOWNER, or prepare the mount for UID/GID 1000."
  exec setpriv --reuid=node --regid=node --init-groups --no-new-privs "$0" "$@"
fi

# Fail before SQLite migration with a useful message, including when the caller
# explicitly runs the image as a non-root UID or uses a read-only mount.
node --input-type=commonjs -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = process.env.DATA_DIR;
  let probe;
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    for (const name of ["app.db", "app.db-wal", "app.db-shm"]) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    }
    probe = fs.mkdtempSync(path.join(dir, ".pictelier-write-check-"));
    fs.writeFileSync(path.join(probe, "check"), "");
  } catch (error) {
    console.error(`Pictelier: data directory ${dir} is not writable by UID/GID ${process.getuid()}/${process.getgid()}: ${error.code}. Check the read-write mount and data permissions.`);
    process.exitCode = 1;
  } finally {
    if (probe) fs.rmSync(probe, { recursive: true, force: true });
  }
' || exit 1

exec "$@"
