# Changelog

## 0.1.0

- 按需拉起 `llama-server`，`/health` 返回 200 后再转发请求。
- 空闲回收：最后一个请求结束后计时，SIGTERM 优雅退出，5 秒后 SIGKILL。
- 并发请求共用同一个启动 Promise，冷启动只起一个进程。
- 固定端口与自动挑选空闲端口都支持，自动端口先真实 bind 再放开。
- host 收到 SIGTERM/SIGINT 时先等进行中的请求结束（最多 10 秒），再关掉子进程。
- 管道看门狗：host 被 SIGKILL 也能在 3 秒内关掉 llama-server，不留孤儿。
- 启动失败返回 503，错误信息带上实际命令行和 llama-server 的 stderr。
- `warmup` 选项可在 host 加载时预热模型。
