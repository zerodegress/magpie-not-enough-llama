import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import { basename, extname, resolve } from "node:path"

const PROVIDER = "local"
const PROVIDER_NAME = "Local llama.cpp"
const SDK = "@ai-sdk/openai-compatible"
const DEFAULT_IDLE_MINUTES = 5
const DEFAULT_START_TIMEOUT_SECONDS = 180
const IDLE_SHUTDOWN_GRACE_MS = 5000
const SIGNAL_SHUTDOWN_GRACE_MS = 1500
const SIGNAL_DRAIN_MS = 10000
const HEALTH_POLL_MS = 200
const HEAD_LINES = 60
const TAIL_LINES = 40
const instances = new Set()
let hooksInstalled = false

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

function reservePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.unref()
    server.once("error", fail)
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

function portIsFree(port) {
  return new Promise((done) => {
    const server = createServer()
    server.unref()
    server.once("error", () => done(false))
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => done(true)))
  })
}

async function healthOk(port, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    await response.text()
    return response.status === 200
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function contextFromArgs(args, fallback) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index])
    if (arg === "-c" || arg === "--ctx-size") {
      const value = Number(args[index + 1])
      if (Number.isFinite(value) && value > 0) return value
    }
    const flag = /^--ctx-size=(\d+)$/.exec(arg)
    if (flag) return Number(flag[1])
    const short = /^-c(\d+)$/.exec(arg)
    if (short) return Number(short[1])
  }
  return fallback
}

function defaultModelId(modelPath) {
  const name = basename(String(modelPath || ""))
  const extension = extname(name)
  return (extension ? name.slice(0, -extension.length) : name) || "local-model"
}

function buildModels(options, extraArgs) {
  const context = contextFromArgs(extraArgs, 8192)
  const listed = Array.isArray(options.models) ? options.models.filter((entry) => entry && entry.id) : []
  const rows = listed.length ? listed : [{ id: defaultModelId(options.model) }]
  const models = {}
  for (const row of rows) {
    const id = String(row.id)
    models[id] = {
      name: String(row.name ?? id),
      limit: {
        context: Math.trunc(positiveNumber(row.limit?.context, context)),
        output: Math.trunc(positiveNumber(row.limit?.output, Math.min(2048, Math.max(256, context / 2)))),
      },
      tool_call: row.tool_call !== false,
      reasoning: row.reasoning === true,
    }
  }
  return models
}

function track(stream, done) {
  const reader = stream.getReader()
  let released = false
  const release = () => {
    if (released) return
    released = true
    done()
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          controller.close()
          release()
          return
        }
        controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
        release()
      }
    },
    cancel(reason) {
      release()
      return reader.cancel(reason)
    },
  })
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function guardServer(pid, modelPath) {
  if (!pid || process.platform === "win32") return null
  const alive = `ps -p ${pid} -o args= 2>/dev/null | grep -F -- ${shellQuote(modelPath)} >/dev/null 2>&1`
  const script = `cat >/dev/null; ${alive} || exit 0; kill -TERM ${pid} 2>/dev/null; sleep 3; ${alive} && kill -KILL ${pid} 2>/dev/null; exit 0`
  try {
    const proc = spawn("/bin/sh", ["-c", script], { stdio: ["pipe", "ignore", "ignore"] })
    proc.on("error", () => {})
    proc.stdin.on("error", () => {})
    proc.unref()
    return proc
  } catch {
    return null
  }
}

function terminate(proc, signal, graceMs) {
  return new Promise((done) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      done()
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(hard)
      clearTimeout(bail)
      done()
    }
    const hard = setTimeout(() => {
      try {
        proc.kill("SIGKILL")
      } catch {}
    }, graceMs)
    const bail = setTimeout(finish, graceMs + 2000)
    proc.once("exit", finish)
    proc.once("close", finish)
    proc.once("error", finish)
    try {
      if (!proc.kill(signal)) finish()
    } catch {
      finish()
    }
  })
}

function createRuntime(options, extraArgs) {
  const bin = String(options.bin ?? "llama-server")
  const modelPath = options.model ? resolve(String(options.model)) : ""
  const fixedPort = Math.trunc(positiveNumber(options.port, 0))
  const idleMinutes = Number.isFinite(Number(options.idleMinutes)) && Number(options.idleMinutes) >= 0 ? Number(options.idleMinutes) : DEFAULT_IDLE_MINUTES
  const idleMs = Math.trunc(idleMinutes * 60000)
  const startTimeoutMs = Math.trunc(positiveNumber(options.startTimeoutSeconds, DEFAULT_START_TIMEOUT_SECONDS) * 1000)

  let child = null
  let port = fixedPort
  let starting = null
  let stopping = null
  let active = 0
  let ready = false
  let idleTimer = null
  let head = []
  let tail = []
  let exited = null
  let guard = null

  function endGuard() {
    const proc = guard
    guard = null
    if (!proc) return
    try {
      proc.stdin.end()
    } catch {}
  }

  function collect(chunk) {
    for (const raw of String(chunk).split("\n")) {
      const line = raw.replace(/\r$/, "")
      if (!line) continue
      if (head.length < HEAD_LINES) head.push(line)
      tail.push(line)
      if (tail.length > TAIL_LINES) tail.shift()
    }
  }

  function excerpt() {
    const lines = head.slice()
    const extra = tail.filter((line) => !lines.includes(line))
    if (extra.length) lines.push("...", ...extra)
    return lines.join("\n")
  }

  function clearIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function scheduleIdle() {
    clearIdle()
    if (!child || idleMs <= 0) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (active > 0) return
      console.log(`[local] idle for ${idleMs} ms, stopping llama-server`)
      stop().catch(() => {})
    }, idleMs)
    idleTimer.unref?.()
  }

  function failureText(reason) {
    const parts = []
    if (reason?.error?.code === "ENOENT") parts.push(`${bin} was not found; install llama.cpp or set the "bin" option`)
    else if (reason?.error) parts.push(reason.error.message)
    else if (reason?.signal) parts.push(`llama-server was killed by ${reason.signal}`)
    else parts.push(`llama-server exited with code ${reason?.code ?? "null"}`)
    parts.push(`command: ${[bin, "-m", modelPath, "--host", "127.0.0.1", "--port", String(port), ...extraArgs].join(" ")}`)
    const log = excerpt()
    if (log) parts.push(log)
    return `local: ${parts.join("\n")}`
  }

  async function boot() {
    if (!modelPath) throw new Error('local: the "model" option is not set')
    if (!existsSync(modelPath)) throw new Error(`local: model file not found: ${modelPath}`)
    if (stopping) await stopping
    if (!port) port = await reservePort()
    else if (!(await portIsFree(port))) {
      if (fixedPort) throw new Error(`local: port ${port} is already in use`)
      port = await reservePort()
    }
    head = []
    tail = []
    exited = null
    const args = ["-m", modelPath, "--host", "127.0.0.1", "--port", String(port), ...extraArgs]
    const started = Date.now()
    console.log(`[local] starting ${[bin, ...args].join(" ")}`)
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] })
    child = proc
    proc.stdout.on("data", collect)
    proc.stderr.on("data", collect)
    const gone = (reason) => {
      if (!exited) exited = reason
      if (child === proc) {
        child = null
        ready = false
      }
      endGuard()
      clearIdle()
    }
    guard = guardServer(proc.pid, modelPath)
    proc.once("error", (error) => gone({ error }))
    proc.once("exit", (code, signal) => gone({ code, signal }))
    const deadline = Date.now() + startTimeoutMs
    while (Date.now() < deadline) {
      if (exited) {
        const reason = exited
        await terminate(proc, "SIGKILL", 0)
        if (child === proc) child = null
        throw new Error(failureText(reason))
      }
      if (await healthOk(port)) {
        ready = child === proc
        console.log(`[local] ready on 127.0.0.1:${port} after ${Date.now() - started} ms`)
        if (active === 0) scheduleIdle()
        return port
      }
      await sleep(HEALTH_POLL_MS)
    }
    await terminate(proc, "SIGKILL", 0)
    if (child === proc) child = null
    throw new Error(`local: llama-server was not ready after ${Math.round(startTimeoutMs / 1000)}s on port ${port}\n${excerpt()}`)
  }

  function ensureStarted() {
    if (stopping) return stopping.then(() => ensureStarted())
    if (child && ready && !exited && port) return Promise.resolve(port)
    if (starting) return starting
    const task = boot()
    starting = task
    task.catch(() => {}).finally(() => {
      if (starting === task) starting = null
    })
    return task
  }

  function stop(graceMs = IDLE_SHUTDOWN_GRACE_MS) {
    clearIdle()
    const proc = child
    if (!proc) return Promise.resolve()
    if (stopping) return stopping
    ready = false
    const task = (async () => {
      await terminate(proc, "SIGTERM", graceMs)
      if (child === proc) child = null
      endGuard()
      if (starting) await starting.catch(() => {})
      console.log("[local] llama-server stopped")
    })()
    stopping = task
    task.catch(() => {}).finally(() => {
      if (stopping === task) stopping = null
    })
    return task
  }

  function killNow() {
    const proc = child
    child = null
    if (!proc) return
    try {
      proc.kill("SIGTERM")
    } catch {}
  }

  function drain(ms) {
    if (active === 0) return Promise.resolve()
    return new Promise((done) => {
      const deadline = Date.now() + ms
      const timer = setInterval(() => {
        if (active > 0 && Date.now() < deadline) return
        clearInterval(timer)
        done()
      }, 100)
      timer.unref?.()
    })
  }

  function failureResponse(error) {
    const message = String(error?.message ?? error)
    console.error(`[local] ${message}`)
    const body = JSON.stringify({ error: { message, type: "local_llm_unavailable", code: "local_llm_unavailable" } })
    return new Response(body, { status: 503, headers: { "content-type": "application/json" } })
  }

  async function forward(input, init, release) {
    const actual = await ensureStarted()
    const request = input instanceof Request ? input : new Request(String(input), init)
    const target = new URL(request.url)
    target.protocol = "http:"
    target.hostname = "127.0.0.1"
    target.port = String(actual)
    const headers = new Headers(request.headers)
    headers.delete("host")
    const payload = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
    const send = () =>
      fetch(target, {
        method: request.method,
        headers,
        body: payload,
        duplex: payload ? "half" : undefined,
        signal: request.signal,
      })
    let response
    try {
      response = await send()
    } catch (error) {
      if (request.signal?.aborted || error?.name === "AbortError") throw error
      console.error(`[local] retrying ${target.pathname} after: ${error?.message ?? error}`)
      response = await send()
    }
    const outHeaders = new Headers(response.headers)
    for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) outHeaders.delete(name)
    if (!response.body) {
      release()
      return new Response(null, { status: response.status, statusText: response.statusText, headers: outHeaders })
    }
    return new Response(track(response.body, release), { status: response.status, statusText: response.statusText, headers: outHeaders })
  }

  async function handle(input, init) {
    clearIdle()
    active += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      active = Math.max(0, active - 1)
      if (active === 0) scheduleIdle()
    }
    try {
      const response = await forward(input, init, release)
      if (!response.body) release()
      return response
    } catch (error) {
      release()
      return failureResponse(error)
    }
  }

  async function prepare() {
    if (port || !modelPath) return
    port = fixedPort || (await reservePort().catch(() => 0))
  }

  function warm() {
    return ensureStarted().catch((error) => {
      console.error(`[local] warmup failed: ${error?.message ?? error}`)
    })
  }

  function baseURL() {
    return `http://127.0.0.1:${port || 8080}/v1`
  }

  return { prepare, ensureStarted, stop, killNow, drain, handle, warm, baseURL }
}

function installHooks() {
  if (hooksInstalled) return
  hooksInstalled = true
  process.on("exit", () => {
    for (const instance of instances) instance.killNow()
  })
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      const runtimes = [...instances]
      Promise.all(runtimes.map((instance) => instance.drain(SIGNAL_DRAIN_MS)))
        .then(() => Promise.all(runtimes.map((instance) => instance.stop(SIGNAL_SHUTDOWN_GRACE_MS))))
        .finally(() => process.exit(0))
    })
  }
}

/** Provider `local`: starts llama-server when a request needs it and stops it after `idleMinutes`. */
export async function LocalLlmPlugin(input, options = {}) {
  const settings = options && typeof options === "object" ? options : {}
  const extraArgs = Array.isArray(settings.extraArgs) ? settings.extraArgs.map(String) : []
  const models = buildModels(settings, extraArgs)
  const runtime = createRuntime(settings, extraArgs)
  instances.add(runtime)
  installHooks()
  await runtime.prepare()
  try {
    await input?.client?.auth?.set({ path: { id: PROVIDER }, body: { type: "api", key: "local" } })
  } catch (error) {
    console.error(`[local] automatic sign-in failed: ${error?.message ?? error}`)
  }
  if (settings.warmup) {
    const timer = setTimeout(() => runtime.warm(), 0)
    timer.unref?.()
  }
  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider[PROVIDER] ??= { name: PROVIDER_NAME, npm: SDK, api: runtime.baseURL(), models }
    },
    auth: {
      provider: PROVIDER,
      methods: [{ type: "api", label: "This machine", placeholder: "local", prompts: [] }],
      loader: async () => ({
        baseURL: runtime.baseURL(),
        apiKey: "local",
        fetch: (request, init) => runtime.handle(request, init),
      }),
      usage: async () => ({ plan: "on demand", windows: [] }),
    },
    provider: {
      id: PROVIDER,
      models: async (provider) => ({ ...provider.models, ...models }),
    },
  }
}
