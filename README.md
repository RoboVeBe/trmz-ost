# TRMZ OST — ost.trmz.app

Fan site for the TRMZ themes: a full-screen boombox visualizer with two tape racks.

- **ost.trmz.app** — viewers: click a tape to play it, control bar, fullscreen, ⬇ download (per tape).
- **ost.trmz.app/admin** — admin only: upload songs, rename / reorder / remove tapes, label colors,
  "fans can download" switch, boombox photo + layout (✏ Edit layout), export videos.
  Every change saves to the site automatically.

## How it's built
| Piece | What |
|---|---|
| `public/index.html` | The whole page (one file). Viewer or admin mode is decided at load. |
| `src/worker.js` | Cloudflare Worker: serves the page, `/api/site`, `/audio/:id`, `/photo`, and the admin API. |
| R2 bucket `trmz-ost` | `site.json` (tape list + layout), `photo`, `audio/<id>` (the songs). |
| Cloudflare Access | Login wall in front of `/admin` and `/api/admin` (email one-time code). |

Editing the page: change `tool/page_src.html`, then run `python3 tool/build.py` to rebuild `public/index.html`.

## One-time Cloudflare setup
1. **R2 bucket** — Dashboard → R2 Object Storage → Create bucket → name `trmz-ost`.
2. **Deploy from GitHub** — Workers & Pages → Create → Import a repository → `RoboVeBe/trmz-ost`.
   Keep the defaults (no build command, deploy command `npx wrangler deploy`). The `ost.trmz.app`
   domain is created by the deploy (if not: Worker → Settings → Domains & Routes → Add → Custom domain).
3. **Access (admin login)** — Zero Trust → Access → Applications → Add → Self-hosted:
   - Name `TRMZ OST admin`, two public hostnames: `ost.trmz.app` path `admin`, and `ost.trmz.app` path `api/admin`
   - Policy: Allow → Include → Emails → your email
   - Copy the **Application Audience (AUD) Tag**; your team name is the first part of `<team>.cloudflareaccess.com`
     (Zero Trust → Settings → Custom domains / Team domain).
4. **Worker variables** — Worker → Settings → Variables and Secrets (type Text):
   `ACCESS_TEAM` = team name, `ACCESS_AUD` = AUD tag, `ADMIN_EMAIL` = your email. Deploy.

Optional/alternative: a Secret `ADMIN_PASSWORD` gives a password sign-in on /admin (works with or without Access).

## Local dev
`npm install`, put `ADMIN_PASSWORD=something` in `.dev.vars`, then `npm run dev` → http://localhost:8787/admin
