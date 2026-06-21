# Unit 7 — Multiplayer & Hosting (Phase 1)

Phase 1 goal: host the game at `unit7.humanoidrobots.com` and let other players
join the same world with just a username, seeing each other move around in real
time (and seeing each other's captures).

There are two pieces:

1. **The game** — static files, hosted on Netlify at your domain. Already builds.
2. **The realtime server** — a small PartyKit service the game connects to over
   a WebSocket. It holds the shared world (who is connected, where they are).
   Netlify can't host a always-on socket server, so this lives on PartyKit
   (Cloudflare) and is deployed separately.

The game connects with a plain browser WebSocket, so **the game bundle has no
extra dependency** — `partykit` is only used to run/deploy the server.

---

## 1. Run it locally (two browser windows = two players)

```bash
npm install            # picks up the new partykit devDependency
npm run party:dev      # starts the realtime server on http://127.0.0.1:1999
npm run dev            # starts the game (Vite) in another terminal
```

Open the Vite URL in two browser windows. In each, enter a different callsign and
hit **JOIN WORLD**. On localhost the game auto-connects to `127.0.0.1:1999`, so
you should see the other player as a tinted robot with a name tag, moving in real
time. Capture an alien in one window and the cyan ring pops in the other.

---

## 2. Deploy the realtime server

```bash
npx partykit login     # one-time, opens the browser (free account)
npm run party:deploy
```

Deploy prints your server host, e.g.:

```
Deployed to https://unit7-world.<your-account>.partykit.dev
```

Copy that host (without `https://`). Then set it as the production host so the
live game knows where to connect. Two ways:

- **Quick / recommended:** edit `PROD_HOST` in `src/game/Net.ts` to
  `unit7-world.<your-account>.partykit.dev` and rebuild. Now the deployed game
  always connects there.
- **Per-embed:** pass it as a prop instead — `<Unit7Game config={{ multiplayerHost:
  "unit7-world.<your-account>.partykit.dev" }} />`.

You can also test the deployed server against any build by adding `?mp=unit7-world.<your-account>.partykit.dev`
to the URL — handy before baking it into `PROD_HOST`.

---

## 3. Host the game at unit7.humanoidrobots.com

The repo already deploys to Netlify (the PR deploy previews). To put it on your
subdomain:

**In Netlify** (your site → Domain management → Add a domain):
1. Add custom domain `unit7.humanoidrobots.com`.
2. Netlify shows you a DNS target — for a subdomain it's a **CNAME** value like
   `your-site-name.netlify.app`.

**In GoDaddy** (humanoidrobots.com → DNS):
1. Add a record: Type **CNAME**, Name **unit7**, Value the
   `your-site-name.netlify.app` target from Netlify, TTL default.
2. Save. DNS can take a few minutes to a couple of hours to propagate.

Back in Netlify, once it sees the record it provisions HTTPS automatically. The
game is then live at `https://unit7.humanoidrobots.com`, and because `PROD_HOST`
points at your PartyKit server, players who open it can join the shared world by
username.

---

## What this does and does not do

**Does:**
- Presence + movement of every player in the same world (zone-filtered:
  earth/mars/moon), name tags, smooth interpolation, auto-reconnect, room cap.
- **Server-authoritative shared aliens.** The server (`party/server.ts`) spawns
  and moves one swarm of aliens that *everyone sees and fights*. Capturing is
  first-claim-wins: your net sends a `claim`, the server picks the winner,
  removes the alien for everyone, and awards the score. The swarm refills over
  time so the world is never empty. In multiplayer the old single-player sunrise
  invasion is suppressed (the shared swarm replaces it).
- **Shared scoreboard.** The server tracks score per player and broadcasts a
  live leaderboard, shown top-right in the HUD.

**Does not yet:** vehicle-accurate remote avatars (remote players are drawn as
robots even when piloting), and shared physics/combat between players (missiles
only affect your own client). Those are the next increments — they extend the
same server.

**Not testable in CI / headless:** real multi-client behavior needs two live
browsers against a running server (local or deployed) as in section 1.
