#!/bin/bash
# Enter the recording namespace (Linux user + mount + UTS namespaces, no root needed): a private tmpfs root owned by this
# user with the host's top-level directories bound in, HOME=/home/demo backed by $DECKENT_DEMO_ROOT/home, the host's
# /home/$USER bound so the project stays reachable, host name deckent-demo, account name demo (uid/gid kept). Nothing propagates to the host.
# Usage: demo-ns.sh [command...]   (default: an interactive bash in $DECKENT_DEMO_PROJECT)
set -eu
export DECKENT_DEMO_ROOT="${DECKENT_DEMO_ROOT:-$HOME/.local/share/deckent-readme-demo}"
export DECKENT_DEMO_PROJECT="${DECKENT_DEMO_PROJECT:-/home/$(id -un)/deckent}"
LIB="$(cd "$(dirname "$0")" && pwd)" U="$(id -u)" G="$(id -g)" ME="$(id -un)"
export LIB U G ME
mkdir -p "$DECKENT_DEMO_ROOT/home" "$DECKENT_DEMO_ROOT/newroot" "$DECKENT_DEMO_ROOT/etc"; chmod 700 "$DECKENT_DEMO_ROOT" "$DECKENT_DEMO_ROOT/home"
# The account name shows in deckent cards ("requested by <user>@<host>"): inside the namespace this uid is called demo.
awk -F: -v OFS=: -v u="$U" '$3==u{$1="demo";$5="demo";$6="/home/demo"}1' /etc/passwd > "$DECKENT_DEMO_ROOT/etc/passwd"
awk -F: -v OFS=: -v g="$G" '$3==g{$1="demo"}1' /etc/group > "$DECKENT_DEMO_ROOT/etc/group"
exec unshare -Ur --mount --uts bash -c '
set -e
R="$DECKENT_DEMO_ROOT/newroot"
mount -t tmpfs -o mode=755 tmpfs "$R"
for e in /*; do n=${e#/}
  if [ -L "$e" ]; then ln -s "$(readlink "$e")" "$R/$n"
  elif [ -d "$e" ] && [ "$n" != home ]; then mkdir "$R/$n"; mount --rbind "$e" "$R/$n"; fi
done
mkdir -p "$R/home/$ME" "$R/home/demo"
mount --rbind "/home/$ME" "$R/home/$ME"
mount --bind "$DECKENT_DEMO_ROOT/home" "$R/home/demo"
mount --bind "$DECKENT_DEMO_ROOT/etc/passwd" "$R/etc/passwd"
mount --bind "$DECKENT_DEMO_ROOT/etc/group" "$R/etc/group"
mkdir "$R/.oldroot"; cd "$R"; pivot_root . .oldroot; umount -l /.oldroot; rmdir /.oldroot
hostname deckent-demo
exec unshare --user --map-user="$U" --map-group="$G" bash --noprofile --norc -c "source \"$LIB/demo-env.sh\"; cd \"\$DECKENT_DEMO_PROJECT\"; if [ \$# -gt 0 ]; then exec \"\$@\"; else exec bash --noprofile --norc; fi" demo "$@"
' ns "$@"
