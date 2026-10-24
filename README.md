# magpie-local-llm

magpie 的本地模型 provider。模型不常驻：收到请求时才拉起 `llama-server`，空闲 `idleMinutes` 分钟后自动关闭。对 agent 来说它就是一个普通 provider，模型名是 `local/<模型名>`。

## 安装

```sh
magpie plugin add ./magpie-local-llm
magpie plugin options magpie-local-llm '{"bin":"/usr/bin/llama-server","model":"/path/to/model.gguf","extraArgs":["-c","8192","-ngl","99"]}'
```

插件加载时会自动签入（key 只是占位符），不需要再跑 `magpie plugin login`。

## 配置

`options` 就是插件的第二个参数：

```json
{
  "bin": "/usr/bin/llama-server",
  "model": "/home/you/models/Some-4B-Q4_K_M.gguf",
  "port": 0,
  "idleMinutes": 5,
  "startTimeoutSeconds": 180,
  "extraArgs": ["-c", "8192", "-ngl", "99"],
  "models": [
    { "id": "some-4b", "name": "Some 4B", "limit": { "context": 8192, "output": 2048 } }
  ]
}
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `bin` | `llama-server` | llama-server 可执行文件 |
| `model` | 必填 | gguf 文件路径 |
| `port` | `0` | 固定端口；`0` 或留空自动挑空闲端口 |
| `idleMinutes` | `5` | 最后一个请求结束后多久关闭；`0` 表示不自动关闭 |
| `startTimeoutSeconds` | `180` | 等 `/health` 就绪的上限 |
| `extraArgs` | `[]` | 原样传给 llama-server |
| `models` | `[]` | 模型条目；为空时用文件名去扩展名 |
| `warmup` | `false` | host 加载时先拉起模型 |

## 说明

- 冷启动要等模型加载完，首次请求的延迟会比较长；想避免就用 `warmup`。
- 模型路径错、显存不够时 llama-server 会退出，请求会拿到 503 和它 stderr 的前几十行。
- 插件 host 退出或重启（含被 SIGKILL）都会关掉自己拉起的 llama-server，不留孤儿进程。
