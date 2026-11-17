# Running the worker automatically on macOS (launchd)

The Solas worker runs agents, tasks, and automations. Normally you start it
yourself with `npm run worker`, and it stops when you close the terminal.
This guide makes macOS keep it running instead. It is **opt-in**: nothing
changes until you run `install`, and `uninstall` undoes it.

## What it does

`scripts/launchd/solas-worker.sh install` writes a LaunchAgent for your own
user (`~/Library/LaunchAgents/local.solas.worker.plist`) and starts it. From
then on macOS:

- starts the worker when you log in;
- restarts it if it crashes or is killed, at most once every 30 seconds;
- leaves it stopped after a graceful stop (SIGTERM, exit code 0).

The worker itself is unchanged: the same command as `npm run worker`, the
same graceful shutdown (runs in progress are stopped and recorded), and the
same recovery when it starts again.

## Commands

Run them from the project folder (`~/Developer/Solas`), as yourself. Never
with `sudo`.

```bash
npm run worker:service -- install
```

```bash
npm run worker:service -- status
```

```bash
npm run worker:service -- logs
```

```bash
npm run worker:service -- stop
```

```bash
npm run worker:service -- start
```

```bash
npm run worker:service -- restart
```

```bash
npm run worker:service -- uninstall
```

| Command | Effect |
| --- | --- |
| `install` | Writes the LaunchAgent and starts the worker. Run again after moving the project or changing Node.js versions. |
| `start` | Starts it (after `stop`, or if it isn't loaded). |
| `stop` | Stops it gracefully. It starts again at your next login, or with `start`. |
| `restart` | Stops it gracefully and starts it again. |
| `status` | Whether it is installed and loaded, its PID, and its last exit code. |
| `logs` | The last 50 lines of its logs; `logs -f` follows them. |
| `uninstall` | Stops it and removes the LaunchAgent. Keeps your database, agent workspaces, `.env.local`, and the logs. |

Don't run `npm run worker` in a terminal at the same time unless you want
two workers. Both work correctly (each claims different runs), but each one
counts toward your Claude usage.

Whether the worker actually works (not only whether macOS started it) is in
Solas: **Settings → Worker**, and the dot in the header.

## Secrets and sign-in

- The LaunchAgent contains paths only: Node.js, the project folder, the env
  file, the log files, and a minimal `PATH`. Your database password stays in
  `.env.local`, which the worker reads itself when it starts
  (`node --env-file`). Nothing secret is copied into the plist or printed.
- The worker reaches Claude through Claude Code's own sign-in, exactly as
  from a terminal. Solas never reads or copies your Claude credentials.
- Logs are in `~/Library/Logs/Solas/`. The worker logs JSON events without
  prompts, replies, or secrets.

## Requirements and what it can't do

- **PostgreSQL must be running.** The worker can't do anything without the
  database. Docker Desktop must be set to start at login ("Start Docker
  Desktop when you sign in"); the container restarts by itself
  (`restart: unless-stopped` in `compose.yaml`). If the database isn't up
  yet, the worker keeps retrying; Settings shows it as degraded, or the
  status as unavailable, until the database is back.
- **Login, not boot.** A LaunchAgent starts after you log in. Before that,
  nothing runs.
- **Sleep and power.** A sleeping or switched-off Mac runs nothing. Scheduled
  runs that pass while it sleeps are recorded as missed, not caught up.
- **Node.js path.** The plist holds the absolute path of the `node` you had
  when you ran `install`. After changing versions (for example with nvm),
  run `install` again.
- **This Mac only.** A server would use systemd instead (M10).

## How it was tested

The supervision was tested for real with a second label and an isolated,
empty database, so no agent could run:

```bash
SOLAS_LAUNCHD_LABEL=local.solas.worker-test SOLAS_ENV_FILE=/absolute/path/to/test.env scripts/launchd/solas-worker.sh install
```

`test.env` contained only a `DATABASE_URL` for a separate `_test` database.
Killing the worker with `kill -9` restarted it (throttled to once every 30
seconds); `stop` stopped it gracefully, and it stayed stopped; `uninstall`
removed it. Autostart at a real login, sleep and wake, and Docker starting
after the worker were not tested.
