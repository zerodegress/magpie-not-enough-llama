# Changelog

## 0.1.0

- 按需拉起 `llama-server`，`/health` 返回 200 后再转发请求。
- 空闲回收：最后一个请求结束后计时，SIGTERM 优雅退出，5 秒后 SIGKILL。
- 并发请求共用同一个启动 Promise，只起一个进程。
- 固定端口与自动挑选空闲端口都支持。
- 插件 host 退出或重启时清理自己拉起的子进程。
- 启动失败返回 503，错误信息带上 llama-server 的 stderr。
- `warmup` 选项可在 host 加载时预热模型。
