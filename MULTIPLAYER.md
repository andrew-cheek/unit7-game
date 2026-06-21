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

## What Phase 1 does and does not do

**Does:** presence + movement of every player in the same world (and same
zone — earth/mars/moon are filtered), name tags, smooth interpolation, automatic
reconnect, a room cap, and broadcasting captures so you see others playing.

**Does not yet:** shared *authoritative* entities. Aliens, score, and pickups
are still simulated per-client, so netting an alien removes it for you, not for
everyone. Remote players are drawn as robots even while piloting a vehicle.
Making the world entities server-owned (one set of aliens everyone fights, shared
scoreboard, combat that affects others) is the next phase — it builds on this
relay by moving entity state into `party/server.ts`.

**Not testable in CI / headless:** real multi-client behavior needs two live
browsers against a running server (local or deployed) as in section 1.
