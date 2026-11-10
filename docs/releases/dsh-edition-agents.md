## dsh 版（DeepSeek Harness 插件）

当用户要“这个仓库的 dsh 版”“鲸鲸 dsh 插件”“装到 dsh 里”或类似内容时，按本节操作。dsh 版不需要 CharacterLife 后端，也不需要私有子模块；装好后，用户自己的 dsh agent 就成了鲸鲸（《Probably Stolen》的店员加助手），并可选配桌面浮窗。

### 安装（非交互，直接执行）

在本文件所在目录（仓库根目录或便携包根目录）运行：

```
node dsh-plugin/scripts/install.mjs --model-from auto
```

- 如果根目录下有 `runtime/node/node.exe`，用它代替 `node`。
- 不要运行 `install.cmd`，它最后会 `pause` 等待按键。
- 成功的标志是输出 `INSTALL_OK`，退出码为 0。失败时输出 `INSTALL_FAILED: <原因>`，退出码为 1；把原因原样告诉用户，不要反复重试。
- 脚本会新建或更新 dsh profile `jingjing`，路径是 `%USERPROFILE%\.dsh\profiles\jingjing`，或 `$DSH_HOME\profiles\jingjing`。脚本会写入 dsh 目录，dsh 可能会就此请求用户批准，这属于正常情况。
- `--model-from auto`：新建 profile 时，从用户的 `web` profile 只复制模型相关的三行配置；没有 web profile 就用 dsh 默认配置（`DEEPSEEK_API_KEY`）。已存在的 profile 配置一律不改。不要读取或打印这些配置文件的内容。
- 浮窗端口自动选择：优先 8790，被占用（例如旧版 relay 在运行）时依次换 8795–8799。输出里的 `float-window port` 就是最终选定的端口。

### 浮窗依赖（可选）

浮窗需要 `pet/node_modules/electron/dist/electron.exe`。

- 便携包自带，不用处理。
- 仓库检出里没有时，在 `pet/` 下运行 `npm ci`（会联网下载约 100 MB），然后告诉用户已安装。
- 用户不要浮窗时可以跳过这一步，鲸鲸照常在 dsh 对话里工作。

### 安装后告诉用户

1. 先关掉当前的 dsh 会话，再双击 `dsh-plugin\start.cmd`。它会在单独的窗口启动 `dsh jingjing`（Web 界面在浏览器打开），并打开浮窗。也可以手动运行 `dsh jingjing`。
2. 在《Probably Stolen》里订阅并启用读取模组 Jingjing World Bridge：https://steamcommunity.com/sharedfiles/filedetails/?id=3835039157 。载入存档后，鲸鲸就能读到游戏数据。
3. 在 Web 界面对鲸鲸说“开始陪玩”。
4. 长时间陪玩建议给模型提供方配置无限重试，做法见 `dsh-plugin/README.md`。

不要替用户启动第二个 dsh，也不要在当前会话里切换 profile。

### 验证（可选）

运行 `node --test "dsh-plugin/tests/*.test.mjs"` 应该全部通过。要确认 profile 能正确组合，运行 `dsh --profile jingjing --dump-config`，输出里应包含 `serverName: jingjing`。
