# Changelog

## 0.3.1

- Renamed from `nocollide` to `slotenv`: the command and the repository. The npm package stays `nocollide`, because npm reserves `slotenv` for being close to `dotenv`; it installs both the `slotenv` and the `nocollide` command
- `slotenv.json` replaces `nocollide.json`; the old file is still read, and `doctor` asks you to rename it
- `SLOTENV_HOME` and `SLOTENV_SLOT` replace `NOCOLLIDE_HOME` and `NOCOLLIDE_SLOT`; the old home variable, the `~/.nocollide` folder and `${NOCOLLIDE_SLOT}` placeholders still work
- `hook install` replaces an old nocollide hook block, and `hook uninstall` removes either

## 0.3.0

New:

- `slotenv hook install`: new worktrees claim a slot by themselves (#23)
- `slotenv env` for sh, PowerShell, cmd and JSON, and `ls --json` (#24)
- Framework default ports in `init`: Vite, Next.js, Nuxt, Astro, Angular, SvelteKit, Django, Flask, Rails (#25)
- `slotenv doctor` (#26)
- MySQL and MariaDB: one database per slot (#27)

Fixes:

- Slot numbers are unique across repositories, so two projects never share ports or database names
- A database that already existed is never dropped
- Each created database is recorded right away, so a later failure cannot leak it
- A failed drop keeps the slot so `down` can be retried; `gc` does the same
- `git worktree move` keeps the slot; `gc` no longer treats a moved worktree as deleted
- Database passwords go through environment variables and are hidden in all messages
- The hook block runs first in an existing hook, works with Husky v9 and with SHA-256 repositories
- Parallel `up` calls in one worktree wait for each other while databases are being created
- `run`, `env` and `port` no longer write or require the env file
- `--` is only a separator when it comes right after `run`
- `run` forwards SIGTERM and SIGHUP to the command
- A lock left by a crashed process is taken over at once, only one waiter can take it over, and a holder only ever removes its own lock
- An interrupted database copy is made again on the next `up` instead of being reused
- Removing a worktree and adding a new one with the same name gives it a fresh slot
- Slot numbers that two repositories shared under 0.2 are split again on `up`
- `run` forwards SIGINT too when it is not attached to a terminal
- SQLite `-wal` and `-shm` files are copied with the database

## 0.2.0

- `databases` in `slotenv.json`: one Postgres database, SQLite file or Redis DB index per slot (#16, #17, #18, #19)
- Postgres databases are cloned from the main database, dropped on `down` and `gc`, kept with `--keep-data`
- `compose`: one `COMPOSE_PROJECT_NAME` per slot (#20)
- `init` detects database URLs and Compose files, and leaves shared service ports such as `DB_PORT` alone (#21)
- `up` hides passwords when it prints database URLs
- `ports` may be empty when `databases` or `compose` is set
- `init` now detects a plain `PORT=` line in `.env.example` (#13)
- `slotenv port` prints plain numbers when `FORCE_COLOR` is set (#10)

## 0.1.0

- First release: `init`, `up`, `down`, `ls`, `gc`, `run` and `port`
