# Roadmap

## v0.1 - ports and env (MVP)

- [x] `nocollide init`: detect dev ports from `package.json` scripts and `.env.example`, write `nocollide.json`
- [x] Slot registry in `~/.nocollide/slots.json` with a file lock (safe when several agents start at once)
- [x] `up` / `down` / `ls` / `gc`
- [x] `run` and `port` for scripts and hard-coded dev servers
- [x] Port check: skip a slot whose port is already listening
- [x] `.env` templating with slot variables
- [x] CI on macOS, Linux and Windows
- [x] Publish to npm

## v0.2 - databases and services

- [x] Postgres: per-slot database cloned from a template database
- [x] SQLite: per-slot file copy
- [ ] MySQL
- [x] Redis: DB index per slot
- [x] Docker Compose: per-slot project name
- [x] `init` detects databases and Compose files

## v0.3 - agent integrations

- [ ] Ready-made instructions for popular coding agents
- [x] git `post-checkout` hook installer
- [x] `nocollide env` and `ls --json` for shells and orchestrators
- [x] `nocollide doctor`
- [x] Framework default ports in `init`
- [ ] Recipes for popular worktree managers and agent orchestrators

## Launch

- [ ] 30-second demo GIF: three agents, three dev servers, three databases, no clashes
- [ ] Show HN post and agent-tooling communities
