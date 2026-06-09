/**
 * Background process manager.
 *
 * Agents running inside channels sessions can spawn long-lived processes here
 * (via MCP tools on the plugin). Processes are owned by the dispatcher — not
 * by any claude tmux session — so they survive the 30-minute idle reaper.
 *
 * Each process gets a stable 8-char hex ID shown in Discord (/procs list) and
 * used with /procs kill. Stdout+stderr are captured in a fixed-size ring buffer
 * (RING_LINES lines) so /procs logs can show recent output without blowing up
 * disk or memory.
 *
 * Processes are NOT auto-restarted. The registry lives in memory; a dispatcher
 * restart clears it (surviving processes become untracked orphans — the boot
 * process-registry reaper handles cleanup if needed).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { makeLogger } from './log.ts'

const RING_LINES = 500

export type BgProcess = {
  id: string
  name: string
  command: string
  args: string[]
  cwd: string
  sessionId: string
  pid: number | null
  startedAt: number
  exitedAt: number | null
  exitCode: number | null
  signal: string | null
}

type Entry = {
  meta: BgProcess
  child: ChildProcess
  ring: string[]
}

export class ProcessManager {
  private byId = new Map<string, Entry>()
  private log = makeLogger('procs')

  spawn(opts: {
    name: string
    command: string
    args: string[]
    cwd?: string
    sessionId: string
  }): { id: string } {
    const id = randomBytes(4).toString('hex')
    const cwd = opts.cwd ?? '/tmp'

    const child = spawn(opts.command, opts.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    // Detach so the process group lives independently of the dispatcher.
    child.unref()

    const meta: BgProcess = {
      id,
      name: opts.name,
      command: opts.command,
      args: opts.args,
      cwd,
      sessionId: opts.sessionId,
      pid: child.pid ?? null,
      startedAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      signal: null,
    }
    const ring: string[] = []
    const entry: Entry = { meta, child, ring }
    this.byId.set(id, entry)

    const pushLine = (data: Buffer) => {
      const text = data.toString('utf8')
      const lines = text.split('\n')
      for (const line of lines) {
        if (!line) continue
        ring.push(line)
        if (ring.length > RING_LINES) ring.shift()
      }
    }
    child.stdout?.on('data', pushLine)
    child.stderr?.on('data', pushLine)

    child.on('exit', (code, signal) => {
      meta.exitedAt = Date.now()
      meta.exitCode = code
      meta.signal = signal
      this.log.info(
        `bg process exited (id=${id}, name=${opts.name}, code=${code}, signal=${signal})`,
      )
    })
    child.on('error', err => {
      meta.exitedAt = Date.now()
      meta.exitCode = -1
      ring.push(`[spawn error] ${err.message}`)
      this.log.warn(`bg process spawn error (id=${id}, name=${opts.name}):`, err)
    })

    this.log.info(
      `spawned bg process (id=${id}, name=${opts.name}, pid=${child.pid}, session=${opts.sessionId})`,
    )
    return { id }
  }

  list(): BgProcess[] {
    return [...this.byId.values()].map(e => ({ ...e.meta }))
  }

  kill(id: string): { ok: boolean; error?: string } {
    const entry = this.byId.get(id)
    if (!entry) return { ok: false, error: `no process with id ${id}` }
    if (entry.meta.exitedAt !== null) return { ok: false, error: 'process already exited' }
    try {
      if (entry.child.pid) {
        process.kill(-entry.child.pid, 'SIGTERM')
      } else {
        entry.child.kill('SIGTERM')
      }
      this.log.info(`killed bg process (id=${id}, name=${entry.meta.name})`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  tail(id: string, lines = 50): { ok: boolean; lines?: string[]; error?: string } {
    const entry = this.byId.get(id)
    if (!entry) return { ok: false, error: `no process with id ${id}` }
    const n = Math.min(Math.max(1, lines), RING_LINES)
    return { ok: true, lines: entry.ring.slice(-n) }
  }
}
