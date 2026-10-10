#!/bin/bash
# Yeni bir sürüm yapar ve güncelleme sunucusuna yüklenecek dizini hazırlar.
#
#   ./release.sh [GPG_ANAHTAR_KİMLİĞİ]
#
# Çıktı: mkosi.output/release/<sürüm>/
#   SHA256SUMS(.gpg)              systemd-sysupdate'in okuduğu dizin
#   mandarinOS_<v>_x86-64.efi      UKI
#   mandarinOS_<v>_x86-64.usr-*.raw  /usr, verity, verity imzası
#   mandarinOS_<v>_x86-64.raw.zst  USB'ye yazılacak kurulum imajı
#
# Sunucudaki dizine bu dosyaları ekleyin; eski sürümleri bir süre tutun.
set -euo pipefail
cd "$(dirname "$0")"

key=${1:-}

mkosi --auto-bump -f build
version=$(cat mkosi.version)
out=mkosi.output
rel=$out/release/$version
rm -rf "$rel"
mkdir -p "$rel"

base="mandarinOS_${version}_x86-64"
cp --reflink=auto "$out/$base.efi" "$rel/"
cp --reflink=auto "$out/$base".usr-*.raw "$rel/"
zstd -T0 -19 -q -o "$rel/$base.raw.zst" "$out/$base.raw"

(
    cd "$rel"
    sha256sum -- *.efi *.usr-*.raw *.raw.zst >SHA256SUMS
    if [[ -n $key ]]; then
        gpg --batch --yes --local-user "$key" --detach-sign --output SHA256SUMS.gpg SHA256SUMS
    else
        echo "UYARI: GPG anahtarı verilmedi, SHA256SUMS imzalanmadı." >&2
    fi
)

echo "Hazır: $rel"
