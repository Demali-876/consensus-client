# Consensus CLI — QA Audit Checklist

Every user-facing action, grouped by surface. Each item is **action → expected result**.
Check the box once you've verified it works. Derived from the code on branch
`codex/anonymous-proxy-profiles` (target release `0.2.0-beta.0`).

> Legend: `⌨` = keypress in the TUI · `$` = shell command · **(state)** = only appears under that condition.

---

## 0. Preconditions / environment matrix

Run the whole suite once per row where it's cheap; at minimum cover **A** and one of **B/C**.

- [ ] **A. Paid tier, wallet present** — `CDP_API_KEY_ID/SECRET/WALLET_SECRET` set (or `CONSENSUS_EVM_KEY`/`CONSENSUS_SVM_KEY`)
- [ ] **B. Free tier** — server reports free mode (`isFreeMode()` true); banners/steps say "free tier"
- [ ] **C. No wallet** — no CDP creds and no raw keys → landing shows the amber "No wallet detected" hint
- [ ] **D. Leased node active** — after `ip lease`, every surface shows `node: <domain> (leased)`
- [ ] **E. Light vs dark theme** — set `theme` in Settings/prefs; re-open TUI; colors + logo variant (`logo-light.bmp` vs `logo-dark.bmp`) switch
- [ ] **F. Custom server** — `CONSENSUS_SERVER_URL` respected by health check + all calls
- [ ] **G. Small terminal** — resize narrow/short; layout doesn't crash (dev sizes to 155×45)

---

## 1. CLI — dispatch & help (`bin/consensus.ts`)

- [ ] `$ consensus` (no args) → boots the TUI (landing)
- [ ] `$ consensus help` / `--help` / `-h` → prints help
- [ ] `$ consensus bogus` → red `Unknown command`, prints help, **exit code 1**
- [ ] Force a throw → crash log written; `Crash log:` + `Process log:` paths printed (uncaughtException / unhandledRejection paths)

### 1a. `consensus setup`
- [ ] `$ consensus setup` (`bun run setup`) → wallet + config generated, writes to `~/.consensus-config.json`, injects `CONSENSUS_*` block into shell profile (idempotent — run twice, no duplicate block)
- [ ] `$ consensus setup --force` (`bun run reset`) → regenerates

### 1b. `consensus ip`
- [ ] `$ consensus ip list` → table (NODE ID / DOMAIN / REGION / SCORE / CAPABILITIES); leased row marked `← leased`
- [ ] `$ consensus ip list --region <r>` → header shows region; filtered
- [ ] `$ consensus ip list` with **no nodes** → `No nodes found.`
- [ ] `$ consensus ip lease <id-or-domain>` → `✓ Leased: <domain>` + hint lines
- [ ] `$ consensus ip lease` (no arg) → usage error, exit 1
- [ ] `$ consensus ip active` → shows leased node details, or "No node leased"
- [ ] `$ consensus ip release` → `✓ Released <domain>`; when none leased → "No node is currently leased."
- [ ] `$ consensus ip bogus` → unknown subcommand usage, exit 1

### 1c. `consensus proxy`
- [ ] `$ consensus proxy fetch <url>` → prints `status statusText` + body
- [ ] `... fetch <url> --method POST --header 'K: V' --region X --cache-ttl 60 --verbose --json` → JSON output includes meta; headers parsed (colon-split)
- [ ] `$ consensus proxy fetch` (no url) → usage error, exit 1
- [ ] `$ consensus proxy start` → forward proxy on `:8080`; live `req/spend/sent/up` ticker; `Ctrl+C` → `✓ Stopped`
- [ ] `... start --port N --budget N --region X --cache-ttl N --network <net>` → header reflects each
- [ ] `$ consensus proxy reverse localhost:3000 --port 8080` → `✓ Listening on :<port> → host:port`; ticker w/ cache hits; `Ctrl+C` stops
- [ ] `$ consensus proxy reverse` (no upstream) → usage error, exit 1
- [ ] `$ consensus proxy reverse badinput` (no port / bad) → invalid-upstream error, exit 1
- [ ] `$ consensus reverse-proxy localhost:3000` (alias) → same as `proxy reverse`
- [ ] leased node → header shows `Node: <domain> (leased)` instead of region

### 1d. `consensus ws`
- [ ] `$ consensus ws token` → prints token / connect_url / expires_in; shows model/minutes/MB + est. cost
- [ ] `... token --model time|data|hybrid --minutes N --megabytes N --region X` → cost recalculates
- [ ] `$ consensus ws connect` → `● connected`, type a line → sent; incoming `←` messages; `Ctrl+C` closes cleanly
- [ ] leased node shown in header when set
- [ ] `$ consensus ws bogus` → unknown subcommand usage, exit 1

### 1e. `consensus tunnel`
- [ ] `$ consensus tunnel http 192.168.1.101` → (macOS) opens **new Terminal window** running the tunnel; parent prints `✓ Tunnel opening`
- [ ] `$ consensus tunnel http 192.168.1.101:3000` → host:port parsed
- [ ] `$ consensus tunnel tcp 192.168.1.101:1883` → tcp path
- [ ] `$ consensus tunnel` / bad type → usage error, exit 1
- [ ] `$ consensus tunnel http` (no target) → usage error, exit 1
- [ ] non-macOS (or `--internal`) → runs inline (no Terminal spawn)

---

## 2. TUI — Landing / Home (`screens/landing.ts`)

Landing has **two modes**: *idle* (nothing running) and *active* (dashboard).

### 2a. Top bar / status
- [ ] Connection dot: `○ checking` → `● connected` (emerald) / `● degraded` (amber) / `● offline` (red); re-polls every 15s
- [ ] Shows `acct <name>`, `tier free|paid`, `v <version>`
- [ ] Health payload with `active_nodes > 0` → "Lease a node" card tag shows `N nodes · live`

### 2b. Idle mode (empty state)
- [ ] Hero banner "Nothing's running yet." + "WELCOME BACK, <NAME>"
- [ ] **(No wallet)** amber "No wallet detected" block with `d` = setup guide hint
- [ ] Four service cards render; focused card has red border + pulse animation on entry
- [ ] ⌨ `←/→` or `h/l` → move card focus (wraps)
- [ ] ⌨ `↑/↓` or `k/j` → also move card focus
- [ ] ⌨ `Enter` → opens focused card's service
- [ ] ⌨ `2`/`3`/`4`/`5` → jump straight to Tunnels / Proxy / Nodes / WebSocket

### 2c. Active mode (dashboard)
- [ ] When a proxy/tunnel/ws is running OR a node leased OR recent session (<5 min) OR `CONSENSUS_FORCE_ACTIVE=1` → dashboard renders instead of cards
- [ ] ⌨ `↑/↓` or `k/j` → move row selection
- [ ] ⌨ `Enter` on a service row → opens that service (tnl→Tunnels, prx/fwd→Proxy, ws→WebSocket); on idle row → palette
- [ ] ⌨ `n` → opens command palette ("new")
- [ ] Live counters update ~1s (also on tunnel-runtime events)

### 2d. Global (both modes)
- [ ] ⌨ `1` (Home tab) → no-op (already home)
- [ ] ⌨ `6` → Settings
- [ ] ⌨ `/` → command palette (see §3)
- [ ] ⌨ `?` → tour (see §4)
- [ ] ⌨ `d` → opens docs URL in browser
- [ ] ⌨ `r`/`R` → re-runs health check
- [ ] ⌨ `q` → inline "Quit consensus? [Y] yes [any] cancel"; `y/Y` quits, any other key cancels
- [ ] ⌨ `Ctrl+C` → quits immediately
- [ ] On real quit with a tunnel attached → tunnel is torn down (no leaked socket)

---

## 3. TUI — Command Palette (`screens/palette.ts`)

- [ ] ⌨ `/` from landing opens it; recents shown first
- [ ] Type to filter; ⌨ `↑/↓` move selection; ⌨ `Backspace` edits query
- [ ] ⌨ `Enter` runs selected command; picked id saved to recents (max 5)
- [ ] ⌨ `Esc` / `Ctrl+C` closes without running
- [ ] Each command works: Open Tunnels/Proxy/Nodes/WebSocket/Settings, Start Forward Proxy, Start Reverse Proxy, Refresh Server Health, Open Docs, Replay Tour, Edit Display Name, Quit

---

## 4. TUI — Tour (`screens/tour.ts`)

- [ ] ⌨ `?` opens tour (also auto-shown first run when `tourCompleted` false)
- [ ] ⌨ `→` / `Enter` → next slide; on last → closes
- [ ] ⌨ `←` → previous slide
- [ ] ⌨ `s` / `Esc` / `Ctrl+C` → skip/close
- [ ] "Replay Tour" from palette resets `tourCompleted` and replays

---

## 5. TUI — Nodes / IP (`screens/ips.ts`)

- [ ] On open → `fetching nodes…` spinner, then node list (or error banner on failure)
- [ ] ⌨ `↑/↓` or `k/j` → scroll rows (viewport scrolls past `VISIBLE_ROWS`)
- [ ] ⌨ `/` → cycle region filter pills; list re-filters
- [ ] ⌨ `r`/`R` → refetch nodes
- [ ] ⌨ `Enter` → opens node detail **modal**
  - [ ] modal ⌨ `Enter` → leases that node; banner/state updates to leased
  - [ ] modal ⌨ `Esc`/`b`/`B` → closes modal, no lease
- [ ] ⌨ `d`/`D` → release currently leased node (no-op if none leased)
- [ ] ⌨ `b`/`B` / `Ctrl+C` → back to landing
- [ ] Keys ignored while loading or when list empty (except back/refresh/region/release)

---

## 6. TUI — Settings (`screens/settings.ts`, `settings-prefs.ts`)

Two tabs: **Wallet** and **Preferences**.

- [ ] ⌨ `w`/`W` → Wallet tab; ⌨ `p`/`P` → Preferences tab
- [ ] ⌨ `b`/`B` / `Ctrl+C` → back to landing

### 6a. Wallet tab
- [ ] Wallet addresses/balances render (EVM/SVM/ICP); `—` when unavailable
- [ ] ⌨ `r`/`R` → refresh balances

### 6b. Preferences tab (each field persists instantly to prefs)
- [ ] ⌨ `↑/↓` or `k/j` → move field cursor (wraps)
- [ ] **Toggle/option fields** — ⌨ `Enter` or `→` cycles forward, `←` cycles back, persists:
  - [ ] `defaultVerbose`, `defaultProtocol` (http/tcp), `defaultWsModel`, `theme`, `defaultNetwork`
- [ ] **Text fields** — ⌨ `Enter` enters edit mode; type / `Backspace`; `Enter` commits + persists; `Esc` cancels:
  - [ ] `defaultProxyPort`, `defaultCacheTtl`, `defaultWsMinutes`, `defaultWsMegabytes`, `defaultBudget` (numeric)
  - [ ] `displayName`, `defaultRegion`, `defaultExcludeNode`, `defaultTarget` (string)
- [ ] Re-open Settings → persisted values reload
- [ ] Changing `displayName` → reflected in landing "WELCOME BACK" + `acct`
- [ ] Changing `theme` → new TUI session uses it

---

## 7. TUI — Proxy

### 7a. Hub / picker (`screens/proxy/hub.ts`, `index.ts`)
- [ ] Lists running workers (if any) + "Forward" + "Reverse" entries
- [ ] ⌨ `↑/↓` or `k/j` → move cursor; ⌨ `Enter` → manage worker / start forward / start reverse
- [ ] ⌨ `b`/`B` / `Ctrl+C` → back

### 7b. Forward setup (`screens/proxy/forward.ts`)
- [ ] Detected local processes list + config form render
- [ ] ⌨ `Tab` → switch **list ⇄ form** section
- [ ] ⌨ `↑/↓` or `k/j` → navigate within active section
- [ ] ⌨ `[` / `]` (in form) → jump between field groups (APP/NODE/ROUTING/PERFORMANCE/WALLET)
- [ ] ⌨ `1`–`5` → select detected process
- [ ] ⌨ `Enter` (form, option field) → cycle value; `←/→` → cycle; changing `family` re-renders chain options
- [ ] ⌨ `Enter` (form, text field) → edit inline
- [ ] ⌨ `Enter` (list) → select highlighted process
- [ ] ⌨ `r`/`R` → rescan processes
- [ ] ⌨ `m`/`M` → **save current config as bookmark**
- [ ] ⌨ `Shift+1`–`Shift+5` (or `! @ # $ %`) → **load bookmark** slot 1–5
- [ ] ⌨ `t`/`T` → swap to Reverse setup
- [ ] ⌨ `s`/`S` → start proxy (hands off to dashboard)
- [ ] ⌨ `b`/`B` / `Esc` / `Ctrl+C` → cancel/back

### 7c. Reverse setup (`screens/proxy/reverse.ts`)
- [ ] Same form/bookmark/nav model as forward
- [ ] ⌨ `s`/`S` → start; ⌨ `t`/`T` → swap to Forward; ⌨ `m`/`M` bookmark; `Shift+1-5` load; `b/Esc/Ctrl+C` cancel

### 7d. Proxy dashboard (`screens/proxy/dashboard.ts`)
- [ ] Live stats tick; input ignored briefly on entry (debounce) and while an action runs
- [ ] **(Forward + managed app)** ⌨ `l`/`L` → launch the managed app against the proxy
- [ ] **(Forward)** ⌨ `t`/`T` → probe/test the managed app health
- [ ] ⌨ `s`/`S` → stop proxy (records final stats) → back; in preview mode just closes
- [ ] ⌨ `b`/`B` / `Ctrl+C` → back

---

## 8. TUI — Tunnel

### 8a. Tunnel setup (`screens/tunnel/setup.ts`)
- [ ] Local + LAN device scan renders
- [ ] ⌨ `h` → protocol HTTP; ⌨ `t` → protocol TCP; ⌨ `p`/`P` → (port toggle) 
- [ ] ⌨ `↑/↓` or `k/j` → navigate; ⌨ `Tab` → switch section
- [ ] ⌨ `1`–`5` → select detected target; `Shift+1-5` → load bookmark
- [ ] ⌨ `r`/`R` → rescan local; ⌨ `l`/`L` → rescan LAN; ⌨ `a`/`A` → toggle "show all LAN"
- [ ] ⌨ `m`/`M` → save bookmark
- [ ] ⌨ `Enter` → edit/toggle field; text edit w/ Backspace/Enter/Esc
- [ ] ⌨ `s`/`S` → start tunnel → dashboard
- [ ] ⌨ `b`/`B` / `Esc` / `Ctrl+C` → back

### 8b. Tunnel dashboard (`screens/tunnel/dashboard.ts`)
- [ ] Re-attaches to an already-running tunnel (navigator routes here if one is live)
- [ ] Live request log streams; status transitions connecting→connected→disconnected/closed shown
- [ ] ⌨ `c`/`C` → clear log view (hides existing entries)
- [ ] ⌨ `p`/`P` → pause/resume log
- [ ] ⌨ `x`/`X` → **stop tunnel** and close
- [ ] ⌨ `q`/`Q`/`b`/`B` / `Ctrl+C` → close view **but tunnel keeps running** (verify it's still up)

### 8c. Tunnel live / CLI path (`screens/tunnel/live.ts`)
- [ ] Runs from `consensus tunnel …`; ⌨ `Ctrl+C` → prompts, ⌨ `y`/`Y` confirms stop

---

## 9. TUI — WebSocket

### 9a. WS setup (`screens/websocket/setup.ts`)
- [ ] Cost breakdown updates live for model: `time` / `data` / `hybrid`
- [ ] ⌨ `↑/↓` or `k/j` → navigate fields
- [ ] ⌨ `←/→` (model row) → cycle model; (network row) → cycle network
- [ ] ⌨ `Enter` on numeric field → edit; digits only; `Backspace`/`Enter` commit/`Esc` cancel (minutes / megabytes)
- [ ] ⌨ `r`/`R` → refresh wallet balance
- [ ] ⌨ `s`/`S` → start (only when minutes ≥ 1 && megabytes ≥ 0)
- [ ] ⌨ `b`/`B` / `Ctrl+C` → back

### 9b. WS dashboard (`screens/websocket/dashboard.ts`)
- [ ] Connects; live log of sent/received
- [ ] ⌨ `s`/`S` (when connected) → enter **send mode**
  - [ ] type message; ⌨ `Enter` → send; ⌨ `Backspace`/`Delete` edit; ⌨ `Esc` → exit send mode
- [ ] ⌨ `c`/`C` → clear log
- [ ] ⌨ `q`/`Q`/`b`/`B` / `Ctrl+C` → shutdown session + close

---

## 10. Cross-cutting checks

- [ ] **Leased node pinning** — with a lease active, proxy/ws/tunnel all route to that node (header shows it)
- [ ] **Budget cap** — set `--budget`/`defaultBudget`; spend stops at limit, stands down to direct fetch
- [ ] **Config persistence** — `~/.consensus-config.json` survives restart; prefs + sessions reload
- [ ] **Session recency** — a session in the last 5 min flips landing to active mode
- [ ] **Bookmarks persist** — save in forward/reverse/tunnel setup, reopen, load slot → values restored
- [ ] **Font check** — first run ensures JetBrains Mono (`ensureJetBrainsMono`) without crashing if absent
- [ ] **Docs link** — `d` opens the correct `DOCS_URL`
- [ ] **No-op safety** — every "back"/quit path destroys the renderer (no stuck alt-screen, terminal restored)
