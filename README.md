# kids-chatbot

A friendly chatbot for kids aged 6+, called **Sparky**. It runs on your own
machine in Docker, keeps a complete log of every conversation in a local SQLite
database, and uses **Cloudflare Workers AI** for the model.

The web UI has a history sidebar and a **New chat** button. Each kid types their
name on first visit; it's remembered in that browser, and the sidebar shows only
the conversations under that name.

The name is a **label, not a login** — there is no password, so anyone who types
"Alex" sees Alex's chats. That's deliberate for a family network where the app
has no accounts at all. Names are matched case-insensitively, so `alex` and
`Alex` are the same person.

## Where things live

| Thing | Where it runs |
|---|---|
| Web UI + server | Your machine (Docker container, port 3000) |
| Chat database | Your machine (`./data/chat.db`, a bind-mounted volume) |
| The model | Cloudflare Workers AI, over the REST API |

Cloudflare is **only** the model provider. There is no Worker, no D1, no KV, and
nothing to deploy — the only thing that leaves your network is the text of the
conversation, sent to Cloudflare to generate each reply.

## Setup

```sh
cp .env.example .env     # then fill in the two Cloudflare values
docker compose up -d --build
```

Open `http://<this-machine-ip>:3000` from any device on the network.

You need two values in `.env`:

- **`CLOUDFLARE_ACCOUNT_ID`** — Cloudflare dashboard → Workers & Pages →
  Overview → *Account ID* (it's also in the right sidebar of any domain).
- **`CLOUDFLARE_API_TOKEN`** — My Profile → API Tokens → Create Token → use the
  **Workers AI** template. `Workers AI: Read` is the only permission it needs.

Without them the app still starts and shows a plain "setup needed" message
instead of a broken chat box.

## Deploying to a server, and getting updates

Pushing to `main` triggers `.github/workflows/docker-publish.yml`, which builds a
`linux/amd64` image and publishes it to
`ghcr.io/lbellows/kids-chatbot:latest`, plus a `:<git-sha>` tag you can pin to or
roll back to. **The server never builds from source** — it pulls that image.

On the server, use `docker-compose.prod.yml`:

```sh
cp .env.example .env      # fill in the two Cloudflare values
docker compose -f docker-compose.prod.yml up -d
```

Update it with:

```sh
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The container is replaced; the bind-mounted database at `./data/chat.db` (and
all chat history) stays put.

### Automatic updates (optional)

`docker-compose.prod.yml` includes a **watchtower** service behind a Compose
profile, so it's off unless you ask for it:

```sh
docker compose -f docker-compose.prod.yml --profile autoupdate up -d
```

It polls GHCR every 6 hours and recreates the container when `:latest` changes.
It's scoped by label to *only* this container, so nothing else on the host is
touched. The trade-off is that a push to `main` reaches the server with no
review step — leave it off if you'd rather pull by hand.

### Backups

The whole chat log is one SQLite file on the host — just copy it:

```sh
cp data/chat.db ./chat-backup-$(date +%F).db
```

## Running without Docker

```sh
npm install
cp .env.example .env
node --env-file=.env server.js
```

## Configuration

Everything is environment variables (see `.env.example`):

| Variable | Default | Notes |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | — | Required for chat to work |
| `CLOUDFLARE_API_TOKEN` | — | Required for chat to work |
| `KIDS_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Any Workers AI text model |
| `PORT` | `3000` | |
| `DB_PATH` | `./data/chat.db` | `/data/chat.db` inside the container |

## Reading the chat log

Every message a kid sends and every reply is stored. The child's message is
written **before** the model is called, so the log stays complete even if a
reply fails or the tab is closed mid-answer.

```sh
sqlite3 data/chat.db "
  SELECT c.kid, datetime(m.ts/1000,'unixepoch','localtime'), m.role, m.content
  FROM messages m JOIN chats c ON c.id = m.chat_id
  ORDER BY m.id DESC LIMIT 40;"
```

Deleting a chat in the UI deletes its messages too (`ON DELETE CASCADE`). If you
want an unerasable record, back up `data/chat.db` on a schedule.

## Safety

The bot is kept age-appropriate by its system prompt — see `prompt.js`, which
documents what it will and won't do. Two things are worth being clear about:

- **There is no content filter** in front of the model or behind it. The
  prompt is the whole safety story, and prompts are not a guarantee. The chat
  log exists so a grown-up can actually check.
- **There is no login.** Anyone who can reach port 3000 can use it, by design —
  it's meant for a home network. **Do not port-forward port 3000 on your
  router.** If you ever want it reachable from outside, put it behind a
  Cloudflare Tunnel with Cloudflare Access in front, the way `lcb-chat` does.

## Layout

```
server.js    Express app: static files, chat/history REST API, SSE streaming
db.js        SQLite schema and queries (chats + messages)
ai.js        Cloudflare Workers AI REST client, streaming
prompt.js    The kid-safety system prompt and history-title helper
public/      The web UI (no build step, no dependencies)
```
