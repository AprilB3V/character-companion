"""鲸鲸浮窗：一个置顶、无边框、可拖动的小窗口，显示中转推来的对话。

安装：pip install pywebview
运行：python float_window.py            （默认 480x360）
      python float_window.py 480 300    （自定义宽高）
拖动：按住头像或名字拖动。关闭：选中窗口后按 Alt+F4。
"""

import os
from pathlib import Path
import sys
import webview

os.environ.setdefault("WEBVIEW2_USER_DATA_FOLDER", str(Path(__file__).resolve().parent / "webview2-cache"))
URL = "http://127.0.0.1:8790/overlay?size=20&turns=3"

width = int(sys.argv[1]) if len(sys.argv) > 1 else 480
height = int(sys.argv[2]) if len(sys.argv) > 2 else 360


# Windows WebView2 content is composited via DirectComposition: pywebview's transparent=True (colour key)
# and layered-window colour keys do not apply to it, only whole-window alpha does (which would fade the portrait too).
webview.create_window(
    "鲸鲸",
    URL,
    width=width,
    height=height,
    on_top=True,
    frameless=True,
    easy_drag=False,
    resizable=True,
    background_color="#0E1622",
)
webview.start()
