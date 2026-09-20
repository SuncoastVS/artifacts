# Artifacts

Upload HTML, CSS, JS, or JSX. Render it in a sandboxed iframe. Share it with a public link.

Built with **Next.js 16** (App Router) + **Supabase** (Postgres) + **Tailwind 4**.
Sign-in is centralized behind the shared hub SSO at
[tools.suncoast.studio](https://tools.suncoast.studio) — this app has no
login/signup pages of its own.

## Features

- Hub SSO auth — one shared session across all `*.tools.suncoast.studio` tools
- Drag-and-drop file upload (or paste code) — multiple files per artifact
- Automatic lossless compression for large saves; original files stay editable
- Live preview, sandboxed iframe rendering
- JSX/TSX support via Babel standalone + React 18 (in the iframe)
- Per-artifact public share link, toggleable
- Artifacts are private by default (owner checks in the service-role data layer)
- Share pages cached for 1h, invalidated immediately on edit/unshare

Artifacts allow up to 6 MiB of decoded file content. Saves above 1 MiB of JSON
are gzip-compressed in the browser and decoded on the server. Compressed uploads
are capped at 3 MiB to leave headroom for the hosting platform's request limit;
already-compressed images may need resizing even within the content limit.
Upload failures appear in the editor without discarding your work. Increasing
Next.js's `serverActions.bodySizeLimit` does not override a platform-level limit.

## Local setup

### 1. Supabase projects

Identity and data are split across two Supabase projects:

- **Identity** — the shared hub SSO project, the same one every tool uses.
  Its URL and anon key go in `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **Data** — this app's own project holding the `artifacts` table, accessed
  server-side with the service role: `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY`.

### 2. Environment

```bash
cp .env.example .env.local
# the URLs are pre-filled; fill in the two keys
```

Beyond the four Supabase vars above:

- `NEXT_PUBLIC_AUTH_COOKIE_DOMAIN` — `.tools.suncoast.studio` in prod, and it
  must be **identical across all tool Vercel projects** (that's what makes the
  session shared). Leave empty for local dev (host-only cookie).
- `HUB_LOGIN_URL` — where signed-out users are sent
  (`https://tools.suncoast.studio/login`).
- `NEXT_PUBLIC_SITE_URL` — this app's own URL.

There are no login/signup pages in this app — sign in through the hub at
[tools.suncoast.studio](https://tools.suncoast.studio).

### 3. Run the SQL migrations

Supabase dashboard → **SQL Editor** → paste and run each file in
[`supabase/migrations/`](./supabase/migrations/) in numeric order:

- [`001_artifacts.sql`](./supabase/migrations/001_artifacts.sql) — `artifacts`
  table + RLS policies.
- [`002_directory_and_description.sql`](./supabase/migrations/002_directory_and_description.sql)
  — `description`, `in_directory`, `owner_email` columns, directory RLS
  policy, and the `owner_email` trigger.
- [`003_backfill_legacy_descriptions.sql`](./supabase/migrations/003_backfill_legacy_descriptions.sql)
  — backfills placeholder descriptions on legacy rows so they pass the
  minimum-length validation on save.
- [`004_share_tokens_for_directory_artifacts.sql`](./supabase/migrations/004_share_tokens_for_directory_artifacts.sql)
  — backfills `share_token` for legacy rows already in the directory.

Migrations 001–004 are idempotent — safe to re-run.
[`005_external_identity.sql`](./supabase/migrations/005_external_identity.sql)
is part of the hub-SSO cutover (drops the local-auth FK + `owner_email`
trigger) and is applied once, at cutover — not before.

### 4. Auth configuration

None here. Providers, redirect URLs, and email confirmation are configured on
the hub's identity project — this app no longer has `/auth/callback` or
login/signup routes. The only auth route it owns is `POST /auth/signout`,
which clears the shared `sb-*` cookies and redirects to the hub login.

### 4b. Branded email templates (optional)

Paste the HTML from [`supabase/templates/`](./supabase/templates/) into
**Authentication → Email Templates** — on the **hub identity project's**
dashboard (project `elkplwruyikftwccarpy`), not this app's data project;
auth emails are sent by the identity project. See
[`supabase/templates/README.md`](./supabase/templates/README.md) for the
file-to-slot mapping.

### 5. Dev server

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000>.

## Deploy to Vercel

### Option A — `vercel` CLI

```bash
pnpm dlx vercel@latest        # first-time link (will prompt to create project)
pnpm dlx vercel env add NEXT_PUBLIC_SUPABASE_URL
pnpm dlx vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
pnpm dlx vercel env add NEXT_PUBLIC_AUTH_COOKIE_DOMAIN   # .tools.suncoast.studio
pnpm dlx vercel env add HUB_LOGIN_URL                    # https://tools.suncoast.studio/login
pnpm dlx vercel env add SUPABASE_URL
pnpm dlx vercel env add SUPABASE_SERVICE_ROLE_KEY
pnpm dlx vercel env add NEXT_PUBLIC_SITE_URL             # https://artifacts.tools.suncoast.studio
pnpm dlx vercel --prod
```

### Option B — GitHub import

1. Push the repo to GitHub.
2. <https://vercel.com/new> → import the repo. Framework auto-detects as Next.js.
3. Add the env vars in **Project Settings → Environment Variables** for
   **Production** and **Preview**:
   - `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` — the shared
     identity (hub SSO) project
   - `NEXT_PUBLIC_AUTH_COOKIE_DOMAIN` — `.tools.suncoast.studio` (identical
     across all tool projects)
   - `HUB_LOGIN_URL` — `https://tools.suncoast.studio/login`
   - `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — this app's own data project
   - `NEXT_PUBLIC_SITE_URL` — your production URL (e.g. `https://artifacts.tools.suncoast.studio`). Set this on **Production only**. Preview deploys don't participate in SSO — the shared `.tools.suncoast.studio` cookie can't reach `*.vercel.app` — so leaving Preview unset (falling back to `http://localhost:3000`) is fine.
4. **Deploy**.

### After the first deploy

No Supabase auth URL configuration is needed here — **Site URL** and redirect
URLs live on the hub's identity project, and this app has no `/auth/callback`
route.

Existing share links keep working — the share token is stored in the DB and
doesn't depend on the host. Any links you sent with `localhost` in them die;
new links picked up from the deployed site use the production host.

## How rendering works

Each artifact is a bundle of files stored as JSONB. On render, the server
builds a single HTML document that's piped into an iframe via `srcDoc`. The
iframe is sandboxed (`sandbox="allow-scripts allow-forms allow-popups allow-modals"`)
so artifact code can't reach into the parent page, cookies, or storage.

- **HTML kind** — finds the entry HTML file (or `index.html`), inlines any
  local `<link>` and `<script>` references against the uploaded files.
- **JSX kind** — concatenates the source files, strips ES `import`/`export`
  syntax, base64-encodes the result into the iframe, then uses Babel standalone
  at runtime to transform JSX and mount the first component named `App`,
  `Page`, `Main`, or the default export.

## Project layout

```
app/
  page.tsx                 Landing page (live JSX demo in an iframe)
  auth/signout/            POST /auth/signout — purges sb-* cookies, redirects to hub login
  dashboard/               User dashboard
  new/                     Create artifact
  a/[id]/                  Owner view + editor + share bar
  d/[id]/                  Directory artifact view (signed-in users)
  directory/               Team directory of shared artifacts
  s/[shareId]/             Public share view (cached, OpenGraph metadata)
  not-found.tsx            404 page
components/
  ArtifactEditor.tsx       Main editor (files, code, preview)
  ArtifactRenderer.tsx     Sandboxed iframe
  ShareBar.tsx             Share toggle + copy
  Header.tsx, FileList.tsx, ui/*
lib/
  renderer.ts              Builds the iframe document
  artifacts.ts             Server actions (create / update / share / delete)
  auth.ts                  requireUser() — hub SSO session + allowlist gate
  supabase/                server.ts (identity session), data.ts (service-role data client)
  utils.ts
supabase/migrations/       SQL schema
proxy.ts                   Session cookie refresh (Next 16 replaces middleware.ts)
vercel.ts                  Vercel deploy config (cache headers)
```
