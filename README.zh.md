# magpie-not-enough-llama

一个 [magpie](https://usemagpie.ai) provider：收到请求时才拉起本地 `llama-server`，空闲后关掉。模型不常驻，但对外就是一个普通的 `local/<模型名>` provider。

## 安装

机器上要有 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server`，没有 npm 依赖。

```sh
magpie plugin add .
magpie plugin options magpie-not-enough-llama '{"bin":"/usr/bin/llama-server","model":"/path/to/model.gguf","extraArgs":["-c","8192","-ngl","99"]}'
```

插件加载时自己签入，不需要 `magpie plugin login`。

## 使用

agent 里模型名是 `local/<id>`。`models` 为空时 id 就是文件名去扩展名：`Some-4B-Q4_K_M.gguf` → `local/Some-4B-Q4_K_M`。

```sh
curl http://127.0.0.1:3425/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"local/some-4b","messages":[{"role":"user","content":"hi"}]}'
```

第一个请求要等模型加载完。最后一个回复结束后再过 `idleMinutes`，进程先 SIGTERM 再 SIGKILL；下一次请求会重新拉起。

### 选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `bin` | `llama-server` | llama.cpp 的 server 可执行文件 |
| `model` | 必填 | GGUF 文件 |
| `port` | `0` | 固定端口；`0` 自动挑空闲端口 |
| `idleMinutes` | `5` | 空闲多久后关闭，`0` 表示不自动关闭 |
| `startTimeoutSeconds` | `180` | 等 `/health` 就绪的上限 |
| `extraArgs` | `[]` | 原样传给 llama-server |
| `models` | `[]` | `{id, name, limit: {context, output}}`；为空时用文件名 |
| `warmup` | `false` | host 加载时先拉起模型 |

起不来的模型会返回 503，里面带实际命令行和 llama-server stderr 的末尾。

[English](README.md)
