# 基线

> 启动、回复、常驻服务、长会话与测试的耗时，同一台机器上按同一方法量，供以后比较。`node scripts/baseline.mjs` 重量（`--only`、`--runs`、`--long-sizes` 见脚本头注释）；TUI 首屏只在有 tmux 的地方量（WSL：`wsl.exe -e bash -c 'cd "$(bash scripts/wsl-copy.sh)" && CI=true node scripts/baseline.mjs --only tui'`）。数值受机器负载影响（P42 的经验），比的是量级与走向，不设门槛、不进 CI。

## 机器

Windows 11，16 线程；Windows 上 Node 24.18.1，WSL（Ubuntu）里 Node 22.23.2。mock 模型，临时 HOME。

## 数值

中位数；括号里是最小–最大。

| 项 | P62 之前（2026-10-26） | P62 之后 |
|---|---|---|
| `tau --version`（Windows，7 次） | 406 ms（391–446） | |
| `tau --help`（Windows，7 次） | 451 ms（423–544） | |
| `tau -p` 一轮、一次工具调用（Windows，4 次） | 693 ms（667–751） | |
| `tau --version`（WSL，7 次） | 287 ms（281–404） | |
| `tau -p` 一轮、一次工具调用（WSL，4 次） | 474 ms（455–489） | |
| TUI 首屏（WSL tmux，`--no-daemon`，4 次） | 762 ms（743–1017） | |
| `tau serve start` 到可接入（Windows） | 1045 ms | |
| 接入常驻服务（连接 + initialize） | 2 ms | |
| 开一个会话（`thread/start`） | 178 ms | |
| 经常驻服务跑一轮（mock，10 次） | 18 ms（17–43） | |
| 常驻服务内存：一个空闲会话 / 跑过 10 轮 | 105 MB / 124 MB | |
| 全量 `npm test`（Windows；1536 个，1531 通过、5 跳过） | 165 s | |

长会话（`scripts/bench-long-session.mjs`，Windows）：

| 条目数 | 10 次工具调用的一轮 | 其中检查 | 冷加载 | 中枢接入 | 经 socket | 列出（1 个文件） | 全屏所有行 | 首次 Ctrl+F | 预渲染后 所有行 / Ctrl+F | /tree 打开 / ↑ / 按键 |
|---|---|---|---|---|---|---|---|---|---|---|
| 2000 | 24 ms | 12 ms | 11.9 ms | 17.1 ms | 79.6 ms | 4.9 ms | 78 ms | 29.5 ms | 2.6 / 2.1 ms | 5.6 / 0 / 0.8 ms |
| 10000 | 22 ms | 5 ms | 67 ms | 119.4 ms | 141.4 ms | 26.4 ms | 268.3 ms | 132.9 ms | 11.1 / 10 ms | 26.8 / 0 / 3.9 ms |
| 30000 | 44 ms | 16 ms | 179.4 ms | 295 ms | 341.4 ms | 47.6 ms | 833.6 ms | 591.8 ms | 42.4 / 62.4 ms | 127.6 / 0 / 16.5 ms |

## 量的时候发现的

- WSL 里的仓库副本（smoke-tui 在那里跑，P48）原先 `tau --version` 要 2.3 秒、TUI 首屏 4.9 秒：npm 的工作区链接（`node_modules/@yophon/*`）在 Windows 上是 junction，经 rsync 到了 WSL 变成指向 `/mnt/d/…` 的绝对链接，凡是按包名的导入都绕回 9P 去读 Windows 盘。`scripts/wsl-copy.sh` 同步后把它们改指副本内部，之后是上表的数字。smoke-tui 首屏偶尔等不到（approval 场景空屏）可能与此有关，62f 再看。
