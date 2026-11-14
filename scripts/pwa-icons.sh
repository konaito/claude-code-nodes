#!/bin/sh
# PWA のアイコン（src/web/pwa/icon-*.png）を ImageMagick で描き直す。512 の格子で描いた図形を4倍で描いて縮める。
# 図形は中央の80%（maskable の安全域）に収める。背景は不透明の白
set -eu
dir="$(cd "$(dirname "$0")/.." && pwd)/src/web/pwa"
k=4
s=$((512 * k))
p() { echo $(($1 * k)); }
big="$(mktemp -t ccn-icon).png"
magick -size ${s}x${s} xc:'#ffffff' \
  -fill none -stroke '#18181b' -strokewidth "$(p 16)" -draw "stroke-linejoin round polygon $(p 256),$(p 166) $(p 160),$(p 346) $(p 352),$(p 346)" \
  -stroke none -fill '#d2452c' -draw "circle $(p 256),$(p 166) $(p 256),$(p 212)" \
  -fill '#18181b' -draw "circle $(p 160),$(p 346) $(p 160),$(p 386)" -draw "circle $(p 352),$(p 346) $(p 352),$(p 386)" \
  "$big"
for n in 512 192 180; do magick "$big" -resize ${n}x${n} -alpha off -strip "PNG24:$dir/icon-$n.png"; done
rm -f "$big"
