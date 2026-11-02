# pi-web

给 [pi](https://pi.dev) coding agent 做的网页界面。界面风格是亮色的 Dear ImGui：直角、紧凑、等宽字体。

**用的是原版 pi，不用改它。** 后端只跑 `pi --mode rpc`，按文档里公开的 RPC 协议收发 JSON。pi 升级以后，一般不用跟着改。

## 用法

```bash
npm install
npm run build     # 构建前端
npm start         # http://127.0.0.1:8787
```

开发模式：`npm run dev`，然后打开 http://localhost:5173 （前端会热更新，后端改了自动重启）。

前提：命令行里能直接运行 `pi`，而且已经登录好或配好模型。

## 能做什么

| 功能 | 怎么用 |
|---|---|
| 对话 | 回复是流式显示的；思考过程默认折叠，工具调用显示成卡片（edit 会画 diff，点路径能打开文件） |
| 运行中插话 | Enter = steer（当前这一步做完就插进去），Alt+Enter = follow-up（全部做完再发），Esc = 停止 |
| `/` 命令 | 输入 `/` 弹出菜单。内置命令由网页翻译成 RPC 调用；扩展命令、prompt 模板、skill 从 pi 动态获取 |
| `!命令` | 直接跑 shell，输出进上下文；`!!命令` 输出不进上下文 |
| 会话和进程 | 每个会话（jsonl 文件）有自己的 pi 进程。同一个目录里的几个会话可以同时跑；开新会话、切到别的会话，原来的在后台接着跑。侧栏会话前面有状态图标：转圈 = 正在回复，实心点 = 有新回复没看，黄点 = 在等你操作，空心圈 = 别的窗口在用 |
| 多个窗口 | 同一个会话可以在好几个标签页/浏览器里打开，内容和吐字实时同步，中途打开的也能接上。第一个打开的窗口是操作者，其他窗口只能看，点「接管」可以把操作权拿过来；操作者关掉或离开 10 秒后自动放开 |
| 切换目录 | 点输入框下面的目录按钮，或者 `/cd`。会回到这个目录上次用的会话；顶栏的「进程」按钮可以看所有进程 |
| 历史 | 左侧栏就是会话列表；`/resume` 或 Ctrl+P 打开会话选择器 |
| 文件 | 顶栏「文件」按钮（Ctrl+E）打开右侧浮动的文件树，点开的文件在顶部标签页里，带语法高亮，Markdown 可以预览；AI 改了文件会自动刷新；点 `@` 可以把文件路径引用到输入框 |
| 终端 | Ctrl+\` 或顶栏按钮打开，和文件一样是顶部的标签页；是真正的 shell（node-pty），刷新页面以后终端还在。标签栏右边有「关闭全部」，标签上右键可以关闭其他 |
| 状态信息 | 花费、缓存命中、tokens、上下文默认收起，点输入框里思考强度右边的按钮（或右键菜单）展开 |
| 图片 | 在输入框里粘贴或拖进来 |
| 扩展 UI | select/confirm/input/editor 弹窗，以及 notify、状态栏、widget、标题都支持 |

### 斜杠命令是怎么对应的

- 下面这些在网页里直接能用（翻译成对应的 RPC 命令）：`/new` `/resume` `/model` `/thinking` `/name` `/compact` `/fork` `/clone` `/session` `/copy` `/export` `/reload`（重启 pi 进程，会话保留）`/quit`。还有网页自己加的 `/cd` `/terminal` `/hotkeys`
- `get_commands` 返回的命令（扩展、模板、skill）原样发给 pi
- `/settings` `/login` `/logout` `/scoped-models` `/tree` 等只有终端界面才有，网页会在下方终端里打开一个真正的 `pi` 让你操作。改完回到网页输入 `/reload` 就生效
- 不认识的 `/xxx` 和终端版一样，当普通文字发出去

## 结构

```
浏览器 (Vue)  ──WebSocket──  server/index.js  ──stdin/stdout JSONL──  pi --mode rpc（每个会话一个）
                │                 │
                └──HTTP──  文件 / 历史会话接口      node-pty ── 终端
```

- `server/pi-agent.js`：管一个 pi 子进程。按 LF 切分 JSONL，把请求和回复按 id 对上；还会缓存没回复的扩展弹窗、扩展状态，以及“进行中”的事件（正在吐的字、正在跑的工具），刷新页面、中途打开的窗口都能接上
- `server/index.js`：HTTP 和 WebSocket。按会话文件管理 pi 进程和操作权。RPC 命令**原样转发**，所以 pi 以后加了新命令，后端不用改。新会话 = 新进程；fork/clone 以后进程跟着去新文件，只是在看旧会话的窗口会给旧文件重新起一个进程
- `server/sessions.js`：读 `~/.pi/agent/sessions/**/*.jsonl` 生成历史列表（只读 header、名称和第一条消息）
- `web/src/store.js`：前端的全部状态和逻辑，包括事件处理、斜杠命令映射、扩展 UI
- `web/src/components/*`：只管显示

### 为什么 pi 升级基本不用改

1. 只用文档里公开的东西：RPC 命令和事件、会话文件格式、CLI 参数
2. 扩展、模板、skill 命令用 `get_commands` 动态获取，不写死
3. 认不出的事件直接忽略；认不出的消息类型折叠起来显示原始 JSON；认不出的工具用通用卡片显示
4. 每次都通过 `pi` 命令启动，跟着你装的版本走

唯一要手动维护的是 `store.js` 里的 `BUILTINS` / `TUI_ONLY` 两张表，也就是 pi 内置终端命令的对应关系。这部分很少变。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 8787 | 端口 |
| `HOST` | 127.0.0.1 | 监听地址 |
| `PI_WEB_TOKEN` | 空 | 设置后访问要带 `?token=xxx`（只用第一次，之后存在浏览器里）。监听非本机地址时一定要设 |
| `PI_BIN` | `pi` | pi 可执行文件 |
| `PI_WEB_PI_ARGS` | 空 | 额外传给 pi 的参数，比如 `--provider anthropic`，也可以写 JSON 数组 |
| `PI_WEB_SHELL` | pwsh / $SHELL | 终端用的 shell |
| `PI_WEB_IDLE_MINUTES` | 30 | 没人看而且空闲的 pi 进程，过多久自动关掉（一句话没说的新会话 2 分钟就关） |

## 注意

- 这是一个能执行任意命令的网页，默认只监听本机。要远程用，请设置 `PI_WEB_TOKEN`，再套 HTTPS 或 Tailscale
- 同一个会话不要同时在终端版 pi 和网页里打开，两个进程一起写同一个会话文件会冲突
- Linux 上 node-pty 需要编译：先装好 `build-essential` 和 `python3`，然后运行 `npm approve-scripts node-pty && npm rebuild node-pty`。装不上也没关系，只是终端功能不能用
