// Netlify SaveTransport: the concrete network surface the CloudStore writes
// through when the backend is a same-origin Netlify Function (instead of the
// PartyKit save party in saveTransport.ts).
//
// saveStore.ts deliberately knows nothing about fetch — it takes a
// SaveTransport. This module supplies one backed by the `save` Netlify Function,
// so an anonymous cloud save round-trips over plain GET/POST against the same
// origin the app is served from (no host/scheme to configure, works on any
// deploy URL or preview).
//
// Wire shape (the server endpoint already exists):
//   GET  /.netlify/functions/save?id=<id>            -> { data: SaveBlob } | {}
//   POST /.netlify/functions/save?id=<id>  body=blob -> { rev: number }
// The function returns an empty object ({}) for "no save under this id", which
// load() maps to null so the store treats it as a fresh/unknown account.

import type { SaveTransport } from './saveStore'
import type { SaveBlob } from './kidShared'

/**
 * Build a SaveTransport that talks to the same-origin Netlify `save` function.
 *
 * Uses a relative URL so it works on any host (production, Netlify previews,
 * local `netlify dev`) with no configuration.
 *
 * Both `save` and `load` throw on a non-OK response so the CloudStore's retry /
 * never-lose logic kicks in (a failed save stays dirty and is flushed later;
 * localStorage already holds the data, so nothing is lost in the meantime).
 */
export function netlifySaveTransport(): SaveTransport {
  const url = (id: string) => `/.netlify/functions/save?id=${encodeURIComponent(id)}`
  const headers = { 'content-type': 'application/json' }

  return {
    async save(id: string, blob: SaveBlob): Promise<number> {
      const res = await fetch(url(id), { method: 'POST', headers, body: JSON.stringify(blob) })
      if (!res.ok) throw new Error(`save failed: ${res.status}`)
      const json = (await res.json()) as { rev?: number }
      // Adopt the server-bumped revision; fall back to the blob's own rev if the
      // server omitted it (older/edge responses) so the store still advances.
      return json.rev ?? blob.rev
    },

    async load(id: string): Promise<SaveBlob | null> {
      const res = await fetch(url(id), { method: 'GET', headers })
      if (!res.ok) throw new Error(`load failed: ${res.status}`)
      const json = (await res.json()) as { data?: SaveBlob } | null
      // The function returns {} for "no save under this id".
      if (!json || json.data == null) return null
      return json.data
    },
  }
}
