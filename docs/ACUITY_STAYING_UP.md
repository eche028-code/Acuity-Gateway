# Acuity Gateway API — keep the server running (hand-off)

> For a Claude Code session on the **Acuity** side. The Gateway API works
> correctly whenever it's reachable; the only blocker now is that the Acuity
> server **does not stay up**.

## Measured behaviour (from the Gateway side)

The API on `:3002` comes up, serves correctly for a **variable window**
(seconds up to ~2 minutes), then **exits and stays down** — it has no
supervisor, so any exit is permanent until a manual restart. A 3-minute
reachability monitor caught: down → up at 23:37:36 → solid `200` for 2 minutes →
then down again right after. Every endpoint works while it's up.

So there are two things to fix: **survive exits**, and **stop exiting**.

## Fix 1 — survive any exit (supervisor)

Run the server under a supervisor that auto-restarts it (and starts it on boot):
- **NSSM** (simplest on Windows — runs it as a Windows service):
  `nssm install AcuityGateway "C:\Program Files\nodejs\node.exe" "<path>\server.js"`,
  set AppDirectory to the project, then start the service. Survives crashes + reboots.
- **pm2**: `npm i -g pm2`, `pm2 start server.js --name acuity`, `pm2 save`
  (+ `pm2-startup` for boot).
- Bare minimum: a `while ($true) { node server.js; Start-Sleep 1 }` loop.

## Fix 2 — find WHY it exits (don't just let restarts mask a bug)

Start it in a terminal you keep visible and watch the moment it dies:
- **Prints a stack trace** → a JS crash. Confirm the `uncaughtException` /
  `unhandledRejection` handlers are actually installed in the real entrypoint,
  and that nothing calls `process.exit()` on an error path. Fix the traced line.
- **Exits with NO output** → it's being **killed externally**, not crashing:
  - **A file-watcher** (`nodemon` / `tsx watch` / `vite`) restarting on file
    changes — check the npm script you launch it with, and whether another
    Claude Code session is editing Acuity files. **Run it without a watcher** for
    the test (`node server.js`, not `npm run dev`).
  - **A duplicate/old process on `:3002`** → the new one fails to bind
    (`EADDRINUSE`) and exits immediately. Before starting:
    `Get-NetTCPConnection -LocalPort 3002` and kill stragglers.
  - **OOM kill** on a memory-tight box → check Task Manager / Event Viewer.

## Confirm it's fixed

Once supervised, it should show **continuous** uptime. The Gateway side has a
reachability monitor; if it logs `200` steadily for several minutes with zero
`DOWN`, we're good and I'll run the full Gateway end-to-end.

## (Optional, prod) bind localhost + `tailscale serve`

For production, run Acuity on `localhost` and expose it with `tailscale serve`
(real TLS cert on the `*.ts.net` hostname, tailnet-only). That removes the
self-signed cert + the `0.0.0.0` LAN exposure — and sidesteps the `:3002`
bind-conflict failure mode above. Doesn't change uptime, but it's the cleaner
deployment.
