/**
 * TransportRegistry — looks up a SessionTransport instance by name.
 *
 * The dispatcher builds one of each at boot. Sessions stamped
 * `transport: "channels"` route through ChannelsTransport; sessions stamped
 * `transport: "per-turn"` route through PerTurnTransport. Both share the same
 * dispatcher.sock and Bun plugin entry point, so the MCP `reply` tool works
 * regardless of transport — the plugin doesn't know or care whether it was
 * loaded by `claude --channels` (channels) or by `claude -p` (per-turn).
 *
 * Adding a new transport (e.g. codex-per-turn, gemini-per-turn) is a matter
 * of: (1) implement SessionTransport, (2) register here, (3) extend
 * Session.transport union in state/sessions.ts.
 */

import type { SessionTransport, TransportInit, TransportName } from './types.ts'
import { ChannelsTransport } from './channels.ts'
import { PerTurnTransport } from './per-turn.ts'

export class TransportRegistry {
  private transports = new Map<TransportName, SessionTransport>()

  constructor(init: TransportInit) {
    this.transports.set('channels', new ChannelsTransport(init))
    this.transports.set('per-turn', new PerTurnTransport(init))
  }

  get(name: TransportName): SessionTransport {
    const t = this.transports.get(name)
    if (!t) throw new Error(`Unknown transport: ${name}. Known: ${[...this.transports.keys()].join(', ')}`)
    return t
  }

  all(): SessionTransport[] {
    return [...this.transports.values()]
  }

  async shutdown(): Promise<void> {
    for (const t of this.transports.values()) {
      try { await t.shutdown() } catch { /* best-effort */ }
    }
  }
}
