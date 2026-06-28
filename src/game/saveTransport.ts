// HTTP SaveTransport: the concrete network surface the CloudStore writes through.
//
// saveStore.ts deliberately knows nothing about WS/fetch — it takes a
// SaveTransport. This module supplies one backed by the PartyKit "save" party's
// HTTP endpoint, so an anonymous cloud save round-trips over plain PUT/GET with
// no socket lifecycle to manage. The realtime transport (chat, presence) is wired
// separately in Net.ts; saves are simple request/response and don't need it.
//
// Wire shape (see kidShared.ts):
//   PUT  /parties/save/:id   body = SaveBlob          -> { rev: number }
//   GET  /parties/save/:id                            -> { data: SaveBlob } | {}
// The save party returns an empty object ({}) for "no save under this id", which
// load() maps to null so the store treats it as a fresh/unknown account.

import type { SaveTransport } from './saveStore'
import type { SaveBlob } from './kidShared'

/**
 * Build a SaveTransport that talks to the PartyKit save party over HTTPS.
 *
 * @param host  the bare PartyKit host (e.g. "unit7.<acct>.partykit.dev"), no scheme.
 * @param party the party name (default 'save').
 *
 * Both `save` and `load` throw on a non-OK response so the CloudStore's retry /
 * never-lose logic kicks in (a failed save stays dirty and is flushed later;
 * localStorage already holds the data, so nothing is lost in the meantime).
 */
export function httpSaveTransport(host: string, party = 'save'): SaveTransport {
  const base = (id: string) => `https://${host}/parties/${party}/${encodeURIComponent(id)}`
  const headers = { 'content-type': 'application/json' }

  return {
    async save(id: string, blob: SaveBlob): Promise<number> {
      const res = await fetch(base(id), { method: 'PUT', headers, body: JSON.stringify(blob) })
      if (!res.ok) throw new Error(`save failed: ${res.status}`)
      const json = (await res.json()) as { rev?: number }
      // Adopt the server-bumped revision; fall back to the blob's own rev if the
      // server omitted it (older/edge responses) so the store still advances.
      return json.rev ?? blob.rev
    },

    async load(id: string): Promise<SaveBlob | null> {
      const res = await fetch(base(id), { method: 'GET', headers })
      if (!res.ok) throw new Error(`load failed: ${res.status}`)
      const json = (await res.json()) as { data?: SaveBlob } | null
      // The save party returns {} for "no save under this id".
      if (!json || json.data == null) return null
      return json.data
    },
  }
}
