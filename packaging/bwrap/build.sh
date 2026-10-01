#!/bin/sh
# Builds a static, non-setuid bubblewrap inside the pinned Alpine image (driver: scripts/build-bwrap.mjs; lock: bwrap.lock.json).
# Input (read-only): /in/bubblewrap-<version>.tar.xz (sha256 already verified by the driver against bwrap.lock.json).
# Output: /out/<arch>/{bwrap,build-info.txt,sysroot-packages.txt}, /out/licenses/bubblewrap-COPYING, /out/host-packages.txt (the
# resolved package sets, compared by the driver with the lock).
# Every package comes from Alpine's signed repositories at the
# exact version the lock names (a removed version fails the build; the lock is then updated deliberately, never silently).
set -eu
# The driver passes direct pins and the complete resolved closures as pkg=version constraints. Empty closures are allowed only
# for the driver's initial --record; normal check mode validates all closures before running this recipe.
version=${BWRAP_VERSION:?} epoch=${SOURCE_DATE_EPOCH:?} host_pkgs=${HOST_PACKAGES:?} sysroot_pkgs=${SYSROOT_PACKAGES:?}
arches=${ARCHES:-x86_64 aarch64}
export SOURCE_DATE_EPOCH="$epoch" TZ=UTC LC_ALL=C

# shellcheck disable=SC2086
apk add --no-cache -q $host_pkgs ${HOST_RESOLVED_PACKAGES:-}
LLVM=/usr/lib/llvm22/bin
mkdir -p /build && cd /build
tar -xJf "/in/bubblewrap-$version.tar.xz"
src=/build/bubblewrap-$version

for arch in $arches; do
  root=/sysroot/$arch
  mkdir -p "$root/etc/apk/keys"
  cp /usr/share/apk/keys/"$arch"/* "$root/etc/apk/keys/"
  cp /etc/apk/repositories "$root/etc/apk/"
  case "$arch" in
    x86_64) resolved_pkgs=${SYSROOT_X86_64_RESOLVED_PACKAGES:-} ;;
    aarch64) resolved_pkgs=${SYSROOT_AARCH64_RESOLVED_PACKAGES:-} ;;
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
  esac
  # shellcheck disable=SC2086
  apk add -q --root "$root" --arch "$arch" --initdb --no-cache --no-scripts $sysroot_pkgs $resolved_pkgs
  target=$arch-alpine-linux-musl
  cat > "/build/cross-$arch.ini" <<EOF
[binaries]
c = 'clang'
ar = '$LLVM/llvm-ar'
strip = '$LLVM/llvm-strip'
pkg-config = 'pkg-config'

[built-in options]
c_args = ['--target=$target', '--sysroot=$root', '-fPIE', '-fstack-protector-strong', '-ffile-prefix-map=/build=.', '-fno-ident']
c_link_args = ['--target=$target', '--sysroot=$root', '-fuse-ld=lld', '-static-pie', '-Wl,-z,relro,-z,now', '-Wl,--build-id=sha1']

[properties]
sys_root = '$root'
pkg_config_libdir = '$root/usr/lib/pkgconfig'

[host_machine]
system = 'linux'
cpu_family = '$arch'
cpu = '$arch'
endian = 'little'
EOF
  # No setuid support exists since 0.12.0 (the binary refuses to run setuid). SELinux labels (--exec-label/--file-label) are left
  # out: libselinux is not linked. assume_kernel=5.15.0 (owner S6, 2026-09-29: minimum kernel 5.15) compiles out the pre-5.6 openat2
  # and pre-5.12 mount_setattr fallbacks, so older kernels are not supported by this build.
  meson setup "/build/b-$arch" "$src" --cross-file "/build/cross-$arch.ini" --buildtype=release --prefer-static \
    -Ddefault_library=static -Db_pie=false -Dtests=false -Dman=disabled -Dselinux=disabled \
    -Dbash_completion=disabled -Dzsh_completion=disabled -Dassume_kernel=5.15.0 >"/build/meson-$arch.log" 2>&1 || { cat "/build/meson-$arch.log"; exit 1; }
  ninja -C "/build/b-$arch" bwrap >"/build/ninja-$arch.log" 2>&1 || { cat "/build/ninja-$arch.log"; exit 1; }
  mkdir -p "/out/$arch"
  "$LLVM/llvm-strip" --strip-all -o "/out/$arch/bwrap" "/build/b-$arch/bwrap"
  chmod 0755 "/out/$arch/bwrap"
  {
    echo "arch: $arch"
    echo "target: $target"
    file -b "/out/$arch/bwrap"
    echo "dynamic section:"; "$LLVM/llvm-readelf" -d "/out/$arch/bwrap" | grep -E 'NEEDED|FLAGS|There is no dynamic' || true
    echo "program interpreter:"; "$LLVM/llvm-readelf" -l "/out/$arch/bwrap" | grep -i interpreter || echo "none"
    echo "sysroot packages:"; apk info --root "$root" --arch "$arch" -v 2>/dev/null | sort
    if [ "$arch" = "$(uname -m)" ]; then echo "version: $("/out/$arch/bwrap" --version)"; else echo "version (qemu-$arch): $("qemu-$arch" "/out/$arch/bwrap" --version)"; fi
    sha256sum "/out/$arch/bwrap"
  } > "/out/$arch/build-info.txt"
  apk info --root "$root" --arch "$arch" -v 2>/dev/null | sort > "/out/$arch/sysroot-packages.txt"
done

mkdir -p /out/licenses
cp "$src/COPYING" /out/licenses/bubblewrap-COPYING
apk info -v 2>/dev/null | sort > /out/host-packages.txt
# The driver reads the outputs as the invoking user.
if [ -n "${OUT_OWNER:-}" ]; then chown -R "$OUT_OWNER" /out; fi
