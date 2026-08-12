# Brain Buzz

Brain Buzz is a read-only public reader for the 6529 community. It surfaces Main
Stage activity, Top 100 member posts, public chats, Punk6529 posts, Explore
stats, and member profiles — all from public 6529 APIs.

Top 100 posts and the public chat feed are **features inside Brain Buzz**, not
separate products. The former standalone
[`6529-chat-feed`](https://github.com/bitternessandwonder/6529-chat-feed) repo
is superseded by this app and can be archived after this consolidation lands.

## Features

- Main Stage leaderboard and movers
- Top 100 posts (members ranked by Level, then matched to recent public drops)
- Public chats (Waves → **All Chats**): search loaded messages, auto-refresh,
  load older pages, and render common image/video attachments
- Punk6529 daily feed
- Explore dashboard and Daily Buzz identity lists
- Member profiles and The Memes gallery
- Same-origin `/api/pfp` proxy for known image hosts (allowlisted)

## Run locally

Requires Node.js 18+.

```bash
npm start
```

Or double-click `START-MAC.command` / `START-WINDOWS.bat`.

Open `http://localhost:3000`.

### Try the chats feature

1. Start the server (`npm start`).
2. Open `http://localhost:3000`.
3. Select **Waves (Chats)** → **All Chats**.
4. Use the search box to filter loaded messages, **Refresh** for the newest
   page (older pages stay loaded), and **Load older chats** for pagination.

The UI calls `GET /api/chats?page=`; the server proxies the public 6529 drops
API, filters to `CHAT` drops, and enriches a small number of author profiles.

## Checks

```bash
npm run check
```

This syntax-checks the server, shared helpers, and browser JS that actually
run, then runs the Node built-in test suite (no npm dependencies).

## Deploy

See [DEPLOY-ONLINE.md](./DEPLOY-ONLINE.md). A Render blueprint lives in
`render.yaml` (health check: `/healthz`).

## API (selected)

| Path | Purpose |
| --- | --- |
| `GET /healthz` | Lightweight health check |
| `GET /api/top-members` | Top 100 members by Level (`?details=1` for enrichment) |
| `GET /api/top-posts?page=` | Public posts from Top 100 members |
| `GET /api/chats?page=` | Public chat drops (CHAT-filtered drops proxy) |
| `GET /api/main-stage-leaderboard?page=` | Main Stage leaderboard |
| `GET /api/movers` | Main Stage movers |
| `GET /api/explore` | Explore dashboard |
| `GET /api/punk-posts?page=` | Punk6529 posts |
| `GET /api/member-profile?identity=` | Member profile |
| `GET /api/memes-gallery` | The Memes gallery |
| `GET /api/daily-buzz-identities?metric=` | Daily Buzz identity pages |
| `GET /api/pfp?src=` | Allowlisted profile-image proxy |

Static UI files are served from `public/` (not embedded in `server.js`).
Shared drop/chat parsing helpers live in `lib/helpers.js`.

## Caching (actual TTLs)

| Data | TTL |
| --- | --- |
| Top members ranking | 6 hours (`MEMBER_CACHE_TTL_MS`) |
| Top posts / chat feed pages | 90 seconds (`FEED_CACHE_TTL_MS`, max 50 entries) |
| Identity profiles | 24 hours |
| Main Stage leaderboard | 60 seconds |
| Explore dashboard | 10 minutes |
| Memes gallery | 30 minutes |

## Limits

- Only public 6529 data is read. Private or gated Wave posts are not included.
- Top posts scan recent drop pages; the UI can request later pages for older
  matches.
- Ranking query parameter casing can vary upstream; Brain Buzz tries several
  variants and re-sorts by Level descending.
- `/api/pfp` only fetches https images from known 6529 / IPFS / Arweave hosts
  (including the live `d3lqz0a4bldqgf.cloudfront.net` media CDN), blocks
  private/link-local resolutions when practical, and rejects SVG.

## License

MIT — see [LICENSE](./LICENSE).
