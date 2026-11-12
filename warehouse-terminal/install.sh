#!/bin/sh
set -eu
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
target="$HOME/.local/share/jplm-warehouse"
applications="$HOME/.local/share/applications"
desktop=$(xdg-user-dir DESKTOP)
install -d "$target" "$applications" "$desktop"
for name in plm.py warehouse.py terminal.css warehouse.png; do
    install -m 644 "$source_dir/$name" "$target/$name"
done
entry="$applications/jplm-warehouse.desktop"
cat > "$entry" <<EOF
[Desktop Entry]
Type=Application
Name=出入库登记
Comment=捷程未来 PLM 出入库登记
Exec=/usr/bin/python3 "$target/warehouse.py"
Icon=$target/warehouse.png
Terminal=false
Categories=Office;
EOF
desktop-file-validate "$entry"
install -m 755 "$entry" "$desktop/出入库登记.desktop"
if [ "${1:-}" = --autostart ]; then
    install -d "$HOME/.config/autostart"
    install -m 644 "$entry" "$HOME/.config/autostart/jplm-warehouse.desktop"
fi
