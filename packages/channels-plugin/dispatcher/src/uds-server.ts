/**
 * UDS NDJSON server for the dispatcher.
 *
 * Listens at PAPERCUP_DISPATCHER_SOCK (default ~/.papercup-channels/dispatcher.sock).
 * Each connection sends a `hello` frame with its session id; subsequent frames
 * are routed by that session.
 *
 * Multiple plugin processes connect to the same socket. The server maintains a
 * Map<sessionId, ConnState> for outbound routing. Reply frames are emitted on
 * an EventEmitter so the discord client can listen for them.
 */

import { EventEmitter } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { existsSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  PluginReply,
  PluginPermissionRequest,
  PluginToDispatcher,
  DispatcherToPlugin,
} from './ipc.ts'
import { makeLogger, type Logger } from './log.ts'

type ConnState = {
  socket: Socket
  session: string | null
  pid: number | null
}

export type UdsServerEvents = {
  reply: (frame: PluginReply) => void
  permissionRequest: (frame: PluginPermissionRequest) => void
  helloReceived: (session: string, pid: number) => void
  pluginDisconnected: (session: string) => void
}

export class UdsServer extends EventEmitter {
  private server: Server | null = null
  private bySession = new Map<string, ConnState>()
  private log: Logger
  constructor(private sockPath: string) {
    super()
    this.log = makeLogger('uds')
  }

  on<E extends keyof UdsServerEvents>(event: E, listener: UdsServerEvents[E]): this {
    return super.on(event, listener)
  }
  emit<E extends keyof UdsServerEvents>(event: E, ...args: Parameters<UdsServerEvents[E]>): boolean {
    return super.emit(event, ...args)
  }

  async start(): Promise<void> {
    const dir = dirname(this.sockPath)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (existsSync(this.sockPath)) {
      try { unlinkSync(this.sockPath) } catch { /* ignore */ }
    }

    const server = createServer(socket => this.onConnection(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.sockPath, () => {
        server.removeListener('error', reject)
        try { chmodSync(this.sockPath, 0o600) } catch { /* best effort */ }
        resolve()
      })
    })
    this.log.info(`listening at ${this.sockPath}`)
  }

  async stop(): Promise<void> {
    if (!this.server) return
    for (const [session, conn] of this.bySession) {
      this.sendTo(session, { type: 'shutdown', session })
      try { conn.socket.end() } catch { /* ignore */ }
    }
    await new Promise<void>(resolve => this.server!.close(() => resolve()))
    this.server = null
  }

  sendTo(session: string, frame: DispatcherToPlugin): boolean {
    const conn = this.bySession.get(session)
    if (!conn || !conn.socket.writable) return false
    try {
      conn.socket.write(JSON.stringify(frame) + '\n')
      return true
    } catch (err) {
      this.log.warn(`write to ${session} failed:`, err)
      return false
    }
  }

  isConnected(session: string): boolean {
    const conn = this.bySession.get(session)
    return !!conn && conn.socket.writable
  }

  private onConnection(socket: Socket): void {
    const state: ConnState = { socket, session: null, pid: null }
    let buf = ''

    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let frame: PluginToDispatcher
        try {
          frame = JSON.parse(line)
        } catch (err) {
          this.log.warn(`bad frame: ${err}`)
          continue
        }
        this.routeFrame(state, frame)
      }
    })

    socket.on('error', err => {
      this.log.warn(`socket error (session=${state.session ?? '?'}):`, err.message)
    })
    socket.on('close', () => {
      if (state.session && this.bySession.get(state.session)?.socket === socket) {
        this.bySession.delete(state.session)
        this.log.info(`plugin disconnected (session=${state.session})`)
        this.emit('pluginDisconnected', state.session)
      }
    })
  }

  private routeFrame(state: ConnState, frame: PluginToDispatcher): void {
    if (frame.type === 'hello') {
      const prev = this.bySession.get(frame.session)
      if (prev && prev.socket !== state.socket) {
        this.log.warn(
          `session ${frame.session} re-registered — closing previous connection`,
        )
        try { prev.socket.end() } catch { /* ignore */ }
      }
      state.session = frame.session
      state.pid = frame.pid
      this.bySession.set(frame.session, state)
      this.log.info(`plugin hello (session=${frame.session}, pid=${frame.pid})`)
      this.emit('helloReceived', frame.session, frame.pid)
      return
    }
    if (state.session === null) {
      this.log.warn('frame received before hello; ignoring')
      return
    }
    if (frame.type === 'reply') {
      if (frame.session !== state.session) {
        this.log.warn(`session spoof: conn=${state.session}, frame=${frame.session}`)
        return
      }
      this.emit('reply', frame)
      return
    }
    if (frame.type === 'permission_request') {
      if (frame.session !== state.session) {
        this.log.warn(`session spoof on permission_request: conn=${state.session}, frame=${frame.session}`)
        return
      }
      this.emit('permissionRequest', frame)
      return
    }
    if (frame.type === 'log') {
      this.log.log(frame.level, `plugin(${state.session}): ${frame.msg}`)
      return
    }
  }
}
