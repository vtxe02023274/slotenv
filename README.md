# nocollide

[![CI](https://github.com/zzoraemon043/nocollide/actions/workflows/ci.yml/badge.svg)](https://github.com/zzoraemon043/nocollide/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/nocollide.svg)](https://www.npmjs.com/package/nocollide)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Run 5 coding agents in parallel. Zero port clashes. Zero shared databases. No containers.**

![Three agents start the same dev server. Without nocollide two of them fail with EADDRINUSE. With nocollide they run on ports 3000, 3010 and 3020.](docs/demo.gif)

> Status: v0.2 handles ports, `.env` files, Postgres, SQLite, Redis and Docker Compose. MySQL is next.

## Install

```bash
npx nocollide init
```

Or install it once with `npm install -g nocollide`. Requires Node.js 22 or newer and git 2.31 or newer. Works on macOS, Linux and Windows.

## The problem

Git worktrees give every agent its own copy of the **files**. They do not give it its own **runtime**:

- Agent A runs `npm run dev` on port 3000. Agent B runs it too: `EADDRINUSE`.
- Both agents run migrations against the same `app_dev` database and break each other's tests.
- `.env` is not copied into new worktrees, so the agent starts without settings, or with the wrong ones.
- Docker Compose project names collide, and one agent's `docker compose down` kills the other's services.

Container-per-agent tools solve this, but they are heavy, slow to start, and replace your whole dev setup. nocollide is the thin layer in between.

## How it works

Each worktree gets a **slot number**. Everything else is derived from it.

```text
main worktree   slot 0   WEB_PORT=3000   db app_dev      redis /0   compose shop
../feat-login   slot 1   WEB_PORT=3010   db app_dev_s1   redis /1   compose shop-s1
../fix-cart     slot 2   WEB_PORT=3020   db app_dev_s2   redis /2   compose shop-s2
```

- The main worktree always keeps slot 0, so your normal setup does not change.
- Other worktrees get the lowest free slot. A slot is skipped when one of its ports is already in use.
- Slots live in `~/.nocollide/slots.json` behind a lock, so ten agents running `up` at the same moment still get ten different slots.

## Usage

```bash
nocollide init            # once per repository: writes nocollide.json
nocollide up              # in a worktree: claims a slot and writes .env.local
nocollide run -- npm run dev   # runs a command with the slot variables set
nocollide port WEB_PORT   # prints one port, handy in scripts
nocollide ls              # every slot of this repository
nocollide down            # releases the slot, drops its databases, removes .env.local
nocollide gc              # the same for worktrees that were deleted
```

`init` reads ports from `.env.example` (`WEB_PORT=3000`) and from `package.json` scripts (`--port 3000`, `-p 3000`, `PORT=3000`), finds database URLs in `.env.example`, notices a Compose file, and writes:

```json
{
  "ports": { "WEB_PORT": 3000, "API_PORT": 4000 },
  "step": 10,
  "env": { "from": ".env.example", "to": ".env.local" },
  "databases": {
    "DATABASE_URL": { "kind": "postgres", "url": "postgres://postgres:postgres@localhost:5432/app_dev" },
    "REDIS_URL": { "kind": "redis", "url": "redis://localhost:6379/0" }
  },
  "compose": true
}
```

Ports of shared services such as `DB_PORT=5432` or `REDIS_PORT=6379` are left out, because every slot should keep talking to the same server. With a Compose file they are kept, because each slot then runs its own containers.

Commit `nocollide.json`. Until you do, new worktrees fall back to the copy in the main worktree.

### The env file

`up` copies `env.from` to `env.to`, sets every port variable and `NOCOLLIDE_SLOT`, and fills `${...}` placeholders:

```dotenv
DATABASE_URL=postgres://localhost/app_s${NOCOLLIDE_SLOT}
PUBLIC_URL=http://localhost:${WEB_PORT}
```

nocollide never overwrites an env file it did not write. Move your own values into the template, or pass `--force`.

### Databases

Each entry in `databases` is an env variable. Slot 0 keeps the value as written; every other slot gets its own database:

| kind | slot 2 gets | on `up` | on `down` |
| --- | --- | --- | --- |
| `postgres` | `app_dev_s2` | created with `CREATE DATABASE ... TEMPLATE app_dev`, so schema and seed data come along | dropped |
| `sqlite` | its own copy of `path` inside the worktree | copied from the main worktree if missing | kept with the worktree |
| `redis` | DB index `base + 2` | nothing to create | nothing to drop |

- Postgres uses the `psql` client, which must be on your `PATH`. Set `"template": false` to start each slot with an empty database instead.
- Copying a template needs nobody connected to it. If the main dev server is running, nocollide tells you to stop it or to use `"template": false`.
- `down --keep-data` and `gc --keep-data` keep the databases. nocollide only drops databases it created itself.

### Docker Compose

With `"compose": true`, every slot gets `COMPOSE_PROJECT_NAME` (`shop`, `shop-s1`, `shop-s2`, ...), so containers, networks and volumes stay apart and `docker compose down` in one worktree leaves the others alone. Run Compose through nocollide so it sees the slot ports too:

```bash
nocollide run -- docker compose up
```

### Make your dev server use the port

Most frameworks read `PORT` or a variable you pass in config. If a script hard-codes a port, either make it read the variable, or start it through nocollide:

```bash
nocollide run -- npm run dev
```

### Tell your agents

Add one line to `AGENTS.md` or your agent's instructions file:

```text
Before starting a dev server or tests in a worktree, run `npx nocollide up` and use the ports and database URLs in .env.local.
```

## Non-goals

- Not a worktree manager. Keep using `git worktree`, or your favourite wrapper.
- Not a sandbox. Agents still share your machine; use containers if you need security isolation.

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## License

MIT
