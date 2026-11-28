#!/bin/bash
# 观潮看盘 Mac 启动器
# 用独立的浏览器配置启动一个“应用窗口”：即使 Chrome 已经开着也一定会弹出程序窗口，
# 画线、自选、API Key 等设置固定保存在 ~/Library/Application Support/GuanChao 里。
DIR="$(cd "$(dirname "$0")" && pwd)"
# 把路径转成合法的 file:// 地址（中文和空格要编码）
ENC="$(printf '%s' "$DIR/index.html" | /usr/bin/perl -pe 's/([^A-Za-z0-9\/._~-])/sprintf("%%%02X", ord($1))/ge')"
URL="file://$ENC"
PROFILE="$HOME/Library/Application Support/GuanChao"
# 记下程序文件夹的位置：观潮看盘.app 被挪走后也能找到
mkdir -p "$PROFILE" && printf '%s' "$DIR" > "$PROFILE/app-dir"
for BIN in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; do
  if [ -x "$BIN" ]; then
    mkdir -p "$PROFILE"
    nohup "$BIN" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
      --app="$URL" --window-size=1440,900 >/dev/null 2>&1 &
    disown
    echo "观潮看盘已启动，这个终端窗口可以关掉。"
    exit 0
  fi
done
open "$DIR/index.html"
