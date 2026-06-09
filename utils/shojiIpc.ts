import Gio from "gi://Gio"
import GLib from "gi://GLib"

// Client that connects to the Unix socket opened by ShojiWM's TS config runtime (Node).
// Newline-delimited JSON:
//   send: {"method": string, "params"?: unknown} (command / fire-and-forget)
//        {"id": number, "method": ..., "params": ...} (request expecting a response)
//   recv: {"event": string, "payload": unknown} (broadcast)
//        {"id": number, "result"|"error": ...} (response to a request)
//
// The socket is recreated on config hot-reload, so reconnect automatically on disconnect.

export type ShojiIpcMessage =
  | { event: string; payload: unknown }
  | { id: number; result?: unknown; error?: string }

export interface ShojiIpcClient {
  /** Send a command (no response expected) */
  send(method: string, params?: unknown): void
  /** Send a request with an id. The response arrives at onMessage as {id, result} */
  request(method: string, params?: unknown): void
  /** Disconnect and stop reconnecting */
  close(): void
}

export function shojiSocketPath(): string {
  const runtimeDir = GLib.getenv("XDG_RUNTIME_DIR") ?? "/tmp"
  const display = GLib.getenv("WAYLAND_DISPLAY") ?? "wayland-0"
  return `${runtimeDir}/shojiwm-${display}.sock`
}

export interface ShojiIpcOptions {
  /** Sent right after each connection is established (e.g. to fetch the initial state) */
  onConnect?: (client: ShojiIpcClient) => void
  /** Delay before reconnecting (ms) */
  reconnectMs?: number
}

export function connectShojiIpc(
  onMessage: (message: ShojiIpcMessage) => void,
  options: ShojiIpcOptions = {},
): ShojiIpcClient {
  const reconnectMs = options.reconnectMs ?? 1000

  let connection: Gio.SocketConnection | null = null
  let output: Gio.OutputStream | null = null
  let cancellable = new Gio.Cancellable()
  let reconnectTimer: number | null = null
  let closed = false

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      GLib.source_remove(reconnectTimer)
      reconnectTimer = null
    }
  }

  function teardownConnection() {
    if (!connection) {
      return
    }
    try {
      connection.close(null)
    } catch {
      // ignore
    }
    connection = null
    output = null
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer !== null) {
      return
    }
    reconnectTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, reconnectMs, () => {
      reconnectTimer = null
      tryConnect()
      return GLib.SOURCE_REMOVE
    })
  }

  function handleDisconnect() {
    teardownConnection()
    scheduleReconnect()
  }

  function readLoop(input: Gio.DataInputStream) {
    input.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, res) => {
      if (closed) {
        return
      }
      let line: string | null
      try {
        ;[line] = (stream as Gio.DataInputStream).read_line_finish_utf8(res)
      } catch {
        handleDisconnect()
        return
      }

      if (line === null) {
        // EOF: the server disconnected
        handleDisconnect()
        return
      }

      const trimmed = line.trim()
      if (trimmed.length > 0) {
        try {
          onMessage(JSON.parse(trimmed) as ShojiIpcMessage)
        } catch {
          // Ignore malformed lines
        }
      }

      readLoop(input)
    })
  }

  function tryConnect() {
    if (closed) {
      return
    }

    const client = new Gio.SocketClient()
    const address = Gio.UnixSocketAddress.new(shojiSocketPath())

    client.connect_async(address, cancellable, (_src, res) => {
      if (closed) {
        return
      }
      try {
        connection = client.connect_finish(res)
      } catch {
        scheduleReconnect()
        return
      }

      output = connection.get_output_stream()
      const input = new Gio.DataInputStream({
        base_stream: connection.get_input_stream(),
      })
      readLoop(input)
      options.onConnect?.(api)
    })
  }

  function writeFrame(message: object) {
    if (!output) {
      return
    }
    try {
      output.write_all(JSON.stringify(message) + "\n", null)
    } catch {
      handleDisconnect()
    }
  }

  let nextRequestId = 1

  function send(method: string, params?: unknown) {
    writeFrame(params === undefined ? { method } : { method, params })
  }

  function request(method: string, params?: unknown) {
    const id = nextRequestId++
    writeFrame(params === undefined ? { id, method } : { id, method, params })
  }

  const api: ShojiIpcClient = {
    send,
    request,
    close() {
      closed = true
      clearReconnectTimer()
      cancellable.cancel()
      teardownConnection()
    },
  }

  tryConnect()
  return api
}
