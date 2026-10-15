#!/bin/sh
# Resolve a candidate closure in the same digest-pinned image, never in the normal build path.
set -eu
apk add --no-cache -q $HOST_NAMES
apk upgrade --no-cache -q
apk info -v 2>/dev/null | sort > /out/host-packages.txt
for arch in $ARCHES; do
  root=/sysroot/$arch
  mkdir -p "$root/etc/apk/keys"
  cp /usr/share/apk/keys/"$arch"/* "$root/etc/apk/keys/"
  cp /etc/apk/repositories "$root/etc/apk/"
  apk add --root "$root" --arch "$arch" --initdb --no-cache --no-scripts -q $SYSROOT_NAMES
  apk info --root "$root" --arch "$arch" -v 2>/dev/null | sort > "/out/sysroot-$arch-packages.txt"
done
if [ -n "${OUT_OWNER:-}" ]; then chown -R "$OUT_OWNER" /out; fi
