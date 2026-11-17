# slotenv

[![CI](https://github.com/zzoraemon043/slotenv/actions/workflows/ci.yml/badge.svg)](https://github.com/zzoraemon043/slotenv/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/slotenv.svg)](https://www.npmjs.com/package/slotenv)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Run 5 coding agents in parallel. Zero port clashes. Zero shared databases. No containers.**

![slotenv init and hook install once. Then git worktree add gives each new worktree its own port and a copy of the Postgres database, and three agents run their dev servers on ports 3000, 3010 and 3020 against app_dev, app_dev_s1 and app_dev_s2.](docs/demo.gif)

> Renamed from `nocollide`. Old `nocollide.json` files, hooks and env files keep working; `slotenv doctor` tells you what to rename.

> Status: v0.3 handles ports, `.env` files, Postgres, MySQL, SQLite, Redis and Docker Compose, and can set up new worktrees by itself through a git hook.

## Install

```bash
npx slotenv init
```

Or install it once with `npm install -g slotenv`. Requires Node.js 22 or newer and git 2.31 or newer. Works on macOS, Linux and Windows.

## The problem

Git worktrees give every agent its own copy of the **files**. They do not give it its own **runtime**:

- Agent A runs `npm run dev` on port 3000. Agent B runs it too: `EADDRINUSE`.
- Both agents run migrations against the same `app_dev` database and break each other's tests.
- `.env` is not copied into new worktrees, so the agent starts without settings, or with the wrong ones.
- Docker Compose project names collide, and one agent's `docker compose down` kills the other's services.

Container-per-agent tools solve this, but they are heavy, slow to start, and replace your whole dev setup. slotenv is the thin layer in between.

## How it works

Each worktree gets a **slot number**. Everything else is derived from it.

```text
main worktree   slot 0   WEB_PORT=3000   db app_dev      redis /0   compose shop
../feat-login   slot 1   WEB_PORT=3010   db app_dev_s1   redis /1   compose shop-s1
../fix-cart     slot 2   WEB_PORT=3020   db app_dev_s2   redis /2   compose shop-s2
```

- The main worktree always keeps slot 0, so your normal setup does not change.
- Other worktrees get the lowest free slot. A slot is skipped when one of its ports is already in use.
- Slot numbers are unique across all your repositories, so two projects with the same ports or database names never collide.
- Slots live in `~/.slotenv/slots.json` behind a lock, so ten agents running `up` at the same moment still get ten different slots.
- `git worktree move` keeps the slot and its databases.

## Usage

```bash
slotenv init            # once per repository: writes slotenv.json
slotenv hook install    # once per clone: new worktrees run "slotenv up" by themselves
slotenv up              # in a worktree: claims a slot and writes .env.local
slotenv run -- npm run dev   # runs a command with the slot variables set
slotenv env             # prints the slot variables (--shell sh|powershell|cmd, --json)
slotenv port WEB_PORT   # prints one port, handy in scripts
slotenv ls              # every slot of this repository (--json for tools)
slotenv down            # releases the slot, drops its databases, removes .env.local
slotenv gc              # the same for worktrees that were deleted
slotenv doctor          # checks the setup and says what to fix
```

`init` reads ports from `.env.example` (`WEB_PORT=3000`) and from `package.json` scripts (`--port 3000`, `-p 3000`, `PORT=3000`), falls back to the framework default (Vite 5173, Next.js 3000, Astro 4321, Angular 4200, Django 8000, Flask 5000, Rails 3000), finds database URLs in `.env.example`, notices a Compose file, and writes:

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

Commit `slotenv.json`. Until you do, new worktrees fall back to the copy in the main worktree.

### The env file

`up` copies `env.from` to `env.to`, sets every port variable and `SLOTENV_SLOT`, and fills `${...}` placeholders:

```dotenv
DATABASE_URL=postgres://localhost/app_s${SLOTENV_SLOT}
PUBLIC_URL=http://localhost:${WEB_PORT}
```

slotenv never overwrites an env file it did not write. Move your own values into the template, or pass `--force`. `run`, `env` and `port` never write the env file, so they also work next to a hand-written `.env.local`.

### Databases

Each entry in `databases` is an env variable. Slot 0 keeps the value as written; every other slot gets its own database:

| kind | slot 2 gets | on `up` | on `down` |
| --- | --- | --- | --- |
| `postgres` | `app_dev_s2` | created with `CREATE DATABASE ... TEMPLATE app_dev`, so schema and seed data come along | dropped |
| `mysql` | `app_dev_s2` | created and filled with `mysqldump app_dev \| mysql app_dev_s2` | dropped |
| `sqlite` | its own copy of `path` inside the worktree | copied from the main worktree if missing | kept with the worktree |
| `redis` | DB index `base + 2` | nothing to create | nothing to drop |

- Postgres uses the `psql` client and MySQL uses `mysql` and `mysqldump`; they must be on your `PATH`. `mysql://` and `mariadb://` URLs both work. Set `"template": false` to start each slot with an empty database instead.
- Copying a template needs nobody connected to it. If the main dev server is running, slotenv tells you to stop it or to use `"template": false`.
- `down --keep-data` and `gc --keep-data` keep the databases. slotenv only drops databases it created itself; a database that already existed is used as it is and left alone.
- If a drop fails, the slot stays claimed so `slotenv down` can be run again.
- Passwords are passed to `psql` and `mysql` through `PGPASSWORD` and `MYSQL_PWD`, never on the command line, and are hidden in every message.

### Docker Compose

With `"compose": true`, every slot gets `COMPOSE_PROJECT_NAME` (`shop`, `shop-s1`, `shop-s2`, ...), so containers, networks and volumes stay apart and `docker compose down` in one worktree leaves the others alone. Run Compose through slotenv so it sees the slot ports too:

```bash
slotenv run -- docker compose up
```

### Make your dev server use the port

Most frameworks read `PORT` or a variable you pass in config. If a script hard-codes a port, either make it read the variable, or start it through slotenv:

```bash
slotenv run -- npm run dev
```

### Automatic setup for new worktrees

```bash
slotenv hook install
```

This adds a git `post-checkout` hook, so `git worktree add` (and every tool built on it) claims a slot and writes `.env.local` before the agent even starts. An existing hook is kept: slotenv adds a marked block and `slotenv hook uninstall` removes only that block. `core.hooksPath` is respected, and with Husky v9 the hook goes into `.husky/post-checkout`.

### Load the variables in a shell

```bash
eval "$(slotenv env)"                          # bash, zsh
slotenv env --shell powershell | Invoke-Expression   # PowerShell
```

### Tell your agents

Add one line to `AGENTS.md` or your agent's instructions file:

```text
Before starting a dev server or tests in a worktree, run `npx slotenv up` and use the ports and database URLs in .env.local.
```

Orchestrators can read `slotenv ls --json` and `slotenv env --json` instead of parsing text.

## Non-goals

- Not a worktree manager. Keep using `git worktree`, or your favourite wrapper.
- Not a sandbox. Agents still share your machine; use containers if you need security isolation.

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## License

MIT
