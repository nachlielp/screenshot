# AWS Migration Plan

Port the backend from Convex to AWS: **one small Node app + RDS MySQL + S3**. Optimized for the simplest possible thing to launch and share — one container, one domain, no CDN, no cron, no websockets.

Decisions already made:

- **Backend**: a single small Node app (not Lambda). It serves the REST API **and** the built web app from one origin — the `vercel.json` `/api/*` proxy trick disappears because everything lives on the same server.
- **No retention/cleanup**: captures live forever. `expiresAt`, `cleanupExpired`, and `crons.ts` are dropped, not ported.
- **No real-time, no polling**: the web app refetches when the tab regains focus. That's it.
- **CI/CD from GitLab**: every push to `main` runs a pipeline that ships the app (Docker image → ECR → App Runner auto-deploys) and, when the extension changed, packs a signed `.crx` to S3. Work Chrome is **enterprise-managed**, so the extension is **self-hosted** and force-installed via admin policy — installed copies auto-update within hours, with no Chrome Web Store and no review lag. No more load-unpacked.

## Target architecture

```
GitLab push ──► pipeline ──► Docker image → ECR ──► App Runner auto-deploys
                        └──► signed .crx + update.xml → S3 ──► managed Chrome auto-updates (admin policy)

Chrome extension ──┐
                   ├── https://app.example.com  ──► Node app (App Runner container)
Web browser ───────┘         /api/*  → REST API          │
                             /*      → static SPA        ├──► RDS MySQL  (data)
                                                          └──► S3        (media, presigned PUT;
Agents (JSON API) ──► same /api/snapshot/<token>                public-read via unguessable keys)
```

- **App Runner** runs the container: auto-HTTPS, custom domain, auto-deploy whenever a new image lands in ECR. No load balancer, no EC2, no Kubernetes.
- **RDS MySQL** (single small instance, e.g. `db.t4g.micro`) reached via an App Runner VPC connector.
- **S3**: media objects stored under random unguessable keys (same security model as today's share tokens / Convex storage URLs). Objects are publicly readable, so the permanent `publicUrl` columns keep working exactly as they do now. Uploads go browser/extension → S3 directly via presigned PUT URLs.
- **Clerk is dropped.** The team is on managed Chrome / Google Workspace, so **Google Sign-In is the auth**: the extension gets a token silently via `chrome.identity` (the browser is already signed into the work account — no sign-in UI at all), the web app shows one Google button, and the server verifies Google tokens and requires the company email domain. One free OAuth client in Google Cloud console; no auth provider, no user management. Share links stay public-token gated (agents need no credentials), exactly as today.

## Phase 1 — Node API skeleton

New package `packages/server/` (TypeScript, Hono + `mysql2`, one Dockerfile).

- Auth middleware (~30 lines with `google-auth-library`): verify the `Authorization: Bearer <token>` — Google ID tokens (web) validate offline against Google's JWKS; `chrome.identity` access tokens (extension) validate via Google's tokeninfo endpoint with a short in-memory cache. Reject emails outside `ALLOWED_EMAIL_DOMAIN`, then resolve/create the `users` row (replaces Convex `auth.config.js` + `getOrCreateUser`).
- Zod validators replacing the `v.object(...)` schemas.
- Serve `packages/web/dist` as static files with an SPA fallback (hash routing means only `/index.html` matters).
- Config via env vars: `DATABASE_URL`, `S3_BUCKET`, `AWS_REGION`, `GOOGLE_CLIENT_IDS` (web + extension OAuth client ids), `ALLOWED_EMAIL_DOMAIN`.

## Phase 2 — MySQL schema

Three tables, direct translation of `convex/schema.ts`. Nested/variable structures become `JSON` columns.

```sql
CREATE TABLE users (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  google_sub  VARCHAR(191) NOT NULL UNIQUE,   -- Google account id (was clerk_id)
  email       VARCHAR(255) NOT NULL,
  name        VARCHAR(255),
  created_at  BIGINT NOT NULL
);

CREATE TABLE screenshots (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id),
  share_token        VARCHAR(64) NOT NULL UNIQUE,
  filename           VARCHAR(512) NOT NULL,
  title              VARCHAR(512),
  mime_type          VARCHAR(128) NOT NULL,
  file_size          BIGINT NOT NULL,
  s3_key             VARCHAR(512) NOT NULL,      -- was storageId
  public_url         TEXT NOT NULL,
  html_s3_key        VARCHAR(512),
  html_public_url    TEXT,
  console_s3_key     VARCHAR(512),
  console_url        TEXT,
  network_s3_key     VARCHAR(512),
  network_url        TEXT,
  source_url         TEXT,
  device             JSON,                        -- all device* fields folded into one JSON column
  capture_timestamp  VARCHAR(64),
  type               ENUM('screenshot','tab-recording','screen-recording') NOT NULL,
  width              INT, height INT, duration DOUBLE,
  created_at         BIGINT NOT NULL,
  is_public          BOOLEAN NOT NULL DEFAULT TRUE,
  view_count         INT NOT NULL DEFAULT 0,
  viewer_tokens      JSON,
  last_viewed_at     BIGINT,
  marked_view        JSON,
  hidden_log_entries JSON,
  annotations        JSON,
  INDEX idx_user (user_id, created_at)
);

CREATE TABLE slideshows (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id),
  share_token         VARCHAR(64) NOT NULL UNIQUE,
  title               VARCHAR(512),
  cover_public_url    TEXT NOT NULL,
  source_url          TEXT,
  frame_count         INT NOT NULL,
  visible_frame_count INT NOT NULL,
  frames              JSON NOT NULL,              -- array of {s3Key, publicUrl, filename, ...}
  created_at          BIGINT NOT NULL,
  is_public           BOOLEAN NOT NULL DEFAULT TRUE,
  view_count          INT NOT NULL DEFAULT 0,
  viewer_tokens       JSON,
  last_viewed_at      BIGINT,
  INDEX idx_user (user_id, created_at)
);
```

Deliberately dropped: `expires_at` columns, `by_expiresAt` indexes.

Migrations: plain numbered `.sql` files run at container start (a 20-line runner) — no ORM/migration framework needed at this size.

## Phase 3 — S3 media flow

- `POST /api/uploads` (auth) → returns `{ key, uploadUrl, publicUrl }`: a random 32-byte-hex key under a type prefix (`media/`, `html/`, `logs/`), a presigned PUT (15 min expiry), and the permanent public URL `https://<bucket>.s3.<region>.amazonaws.com/<key>`. Replaces `generateUploadUrl` — but the client now gets the public URL up front instead of the server resolving `storage.getUrl()` afterwards.
- Bucket: public **read** on objects (via bucket policy), no listing, writes only via presigned URLs. Keys are unguessable, matching today's threat model. CORS config allowing PUT from the app origin and `chrome-extension://*`.
- Deletes: `deleteScreenshot`/`deleteSlideshow` now also issue `DeleteObject` calls for every stored key (Convex did this in one line; we own it now).
- Later optional upgrade (not in scope): CloudFront in front of the bucket for caching — a drop-in change since only the URL prefix changes.

## Phase 4 — REST endpoints (port of the 20 Convex functions)

All routes under `/api`. 🔒 = Google token required (company domain enforced).

| Convex function | REST route |
|---|---|
| `generateUploadUrl` | 🔒 `POST /uploads` |
| `getOrCreateUser` | (implicit in auth middleware) |
| `uploadScreenshot` | 🔒 `POST /screenshots` |
| `getUserScreenshots` / `getUserLibraryItems` | 🔒 `GET /library?search=&cursor=` |
| `getScreenshotByShareToken` / `getScreenshotByToken` | `GET /snapshots/:token` |
| `getSnapshotViewerState` | `GET /snapshots/:token/viewer-state` |
| `incrementViewCount` | `POST /snapshots/:token/view` |
| `updateScreenshotTitle` | 🔒 `PATCH /screenshots/:id/title` |
| `saveMarkedView` | 🔒 `PUT /snapshots/:token/marked-view` |
| `saveScreenshotAnnotations` | 🔒 `PUT /screenshots/:id/annotations` |
| `replaceScreenshotImage` | 🔒 `PUT /screenshots/:id/image` |
| `setHiddenLogEntries` | 🔒 `PUT /screenshots/:id/hidden-logs` |
| `deleteScreenshot` / `deleteScreenshots` | 🔒 `DELETE /screenshots` (body: ids[]) |
| `uploadSlideshow` | 🔒 `POST /slideshows` |
| `getSlideshowByShareToken` / `getSlideshowViewerState` | `GET /slideshows/:token`, `GET /slideshows/:token/viewer-state` |
| `incrementSlideshowViewCount` | `POST /slideshows/:token/view` |
| `updateSlideshowTitle` | 🔒 `PATCH /slideshows/:id/title` |
| `deleteSlideshow` | 🔒 `DELETE /slideshows/:id` |
| `cleanupExpired` (×2), `crons.ts` | **dropped** |

**Agent JSON API** (port of `convex/http.ts`, URL-compatible — existing shared links and the `snapshot-debug` skill keep working unchanged):

- `GET /api/snapshot/:token` — full JSON document (inlines console/network from S3, filters hidden entries)
- `GET /api/snapshot/:token/console` · `/network` — log arrays
- `GET /api/snapshot/:token/image` · `/html` — 302 to the S3 URL
- CORS `*` on these routes, same as today.

## Phase 5 — Web app client swap

- Remove `convex` and `@clerk/clerk-react` entirely; add **TanStack Query** with `refetchOnWindowFocus: true`, `refetchInterval: false` — returning to the Library tab refreshes content, nothing polls.
- Sign-in becomes one **Google Identity Services** button (a `<script>` tag, no npm dependency) that yields an ID token; GIS auto-signs-in on return visits, so in practice you click it once per browser.
- Replace each `useQuery(api.…)` in `App.tsx`, `Library.tsx`, `SnapshotViewer.tsx`, `SlideshowViewer.tsx` with a typed fetch hook against `/api/*`; mutations invalidate the relevant query keys.
- API base URL is just `""` (same origin). `.env.local` shrinks to the Google web client id.
- Delete `vercel.json` (the app is no longer on Vercel and no proxy is needed).

## Phase 6 — Extension client swap + self-hosted distribution (managed Chrome)

Work Chrome is enterprise-managed, so the extension is **self-hosted on S3 and installed via admin policy** — no Chrome Web Store, no review queue.

- **Auth collapses to `chrome.identity.getAuthToken()`**: managed Chrome is already signed into the work Google account, so the token arrives silently — no sign-in page, no "Sync Session" button. Delete the whole Clerk apparatus: `auth-page.html/js`, `auth-callback.html/js`, `clerk-sync.html/js`, `clerk-extractor.js`, and most of `utils/auth.js`. `manifest.json` gains the `identity` permission and an `oauth2` block (client id + email scope).
- Rewrite `packages/extension/utils/convex-client.js` → `api-client.js`: same shape (fresh token per call, retry-once-on-401) but plain REST paths. The upload flow becomes: `POST /api/uploads` → PUT blob to S3 → `POST /api/screenshots` with the keys/URLs.
- Update `utils/runtime-config.js` (one API base URL instead of a Convex deployment URL, **production URL as the default** — no local file edits to install) and `manifest.json` host permissions (app domain + `*.s3.amazonaws.com`).
- **One-time signing key**: generate an RSA key pair (`openssl genrsa 2048`). The **extension ID is derived from this key**, so it's stable forever — guard the private key (GitLab masked CI variable + a copy in a password manager). Losing it means a new extension ID and redoing the admin policy + Google OAuth client.
- **Hosting layout** (public `ext/` prefix on the S3 bucket):
  - `ext/screenshot.crx` — the packed, signed extension (CI overwrites each release)
  - `ext/update.xml` — Chrome's update manifest, regenerated by CI:
    ```xml
    <?xml version="1.0" encoding="UTF-8"?>
    <gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
      <app appid="EXTENSION_ID">
        <updatecheck codebase="https://<bucket>.s3.<region>.amazonaws.com/ext/screenshot.crx"
                     version="1.2.345"/>
      </app>
    </gupdate>
    ```
- **One-time admin policy** (Google Admin console → Chrome → Apps & extensions): force-install (or allow-install) the extension by ID with update URL `https://…/ext/update.xml`. Force-install means it simply appears in everyone's browser; nobody installs anything.
- **One-time Google OAuth clients** (Google Cloud console, free): one "Chrome extension" client bound to the now-permanent extension ID, one "Web application" client for the app domain. These two ids are the server's `GOOGLE_CLIENT_IDS`.
- Rollout behavior: managed Chrome polls the update URL every few hours, so a push reaches every browser the same day with **zero review lag** (chrome://extensions → "Update" forces it immediately). Still keep API changes backward-compatible for one version so a not-yet-updated extension never breaks.
- Load-unpacked remains only a local dev workflow.

## Phase 7 — Data migration (existing captures)

One script (`packages/server/scripts/migrate-from-convex.ts`):

1. `npx convex export` → snapshot of all tables.
2. For each screenshot/slideshow: download each stored file from its Convex URL, upload to S3 under a fresh random key, insert the MySQL row **preserving `shareToken`** — every link already in the wild keeps resolving.
3. Verify counts + spot-check a few share links via the JSON API.

Skip this phase entirely if existing captures don't need to survive (30-day retention means the library empties itself anyway).

## Phase 8 — Provision & launch

Keep infra as a documented checklist (`infra/SETUP.md`) of console/CLI steps — no Terraform/CDK at this scale:

1. **S3**: create bucket, public-read object policy, CORS config.
2. **RDS**: MySQL 8, `db.t4g.micro`, private subnet, 7-day automated backups.
3. **ECR**: one repository for the app image.
4. **IAM**: instance role for the app (S3 put/delete on the bucket), and one CI user/role limited to ECR push (its keys go into GitLab CI variables).
5. **App Runner**: service sourced from the **ECR image** with *auto-deploy on new image push*, VPC connector to reach RDS, env vars + DB password from Secrets Manager.
6. **Domain**: custom domain on App Runner (it provisions the ACM cert), DNS CNAME.
7. **Google OAuth**: created in Phase 6 — just confirm the web client's authorized origin matches the final domain.

## Phase 9 — GitLab CI/CD

One `.gitlab-ci.yml`; every push to `main` ships everything. Repo moves to (or mirrors to) GitLab.

```yaml
stages: [build, release]

deploy-app:                      # web build happens inside the Dockerfile
  stage: build
  image: docker:27
  services: [docker:27-dind]
  script:
    - aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_REGISTRY
    - docker build -t $ECR_REGISTRY/screenshot:latest -t $ECR_REGISTRY/screenshot:$CI_COMMIT_SHORT_SHA .
    - docker push --all-tags $ECR_REGISTRY/screenshot
    # pushing :latest triggers App Runner auto-deploy — nothing else to do

publish-extension:
  stage: release
  rules:
    - changes: [packages/extension/**/*]   # only when the extension actually changed
  script:
    - node scripts/stamp-version.js        # manifest version = base + $CI_PIPELINE_IID (must be strictly increasing)
    - npx crx3 packages/extension -p "$CRX_SIGNING_KEY_FILE" -o screenshot.crx
    - node scripts/make-update-xml.js      # writes update.xml with the new version
    - aws s3 cp screenshot.crx s3://$BUCKET/ext/screenshot.crx
    - aws s3 cp update.xml    s3://$BUCKET/ext/update.xml
```

GitLab CI variables (masked): AWS creds for the CI role (ECR push + `s3://…/ext/*` write), `ECR_REGISTRY`, `BUCKET`, and `CRX_SIGNING_KEY_FILE` (file-type variable holding the extension's private key from Phase 6).

Deploy story after setup: `git push` → app is live in ~2 minutes; the signed `.crx` lands on S3 in the same pipeline and managed Chrome browsers pick it up on their next update poll (same day, no review). No manual steps anywhere.

## Phase 10 — Cutover

1. Run with both backends live; point a test build of the extension at AWS.
2. Run the migration script (Phase 7), re-verify shared links.
3. Flip DNS; let the pipeline push the new `.crx` (managed browsers auto-update — nobody reinstalls anything).
4. After a quiet week: delete the Convex project and the Vercel project; remove `convex/` and root `convex` dep from the repo.

## What this costs / trades

- ~**$25–35/mo floor**: App Runner (~$5–15 idle), RDS t4g.micro (~$12–15), S3 pennies. Convex+Vercel free tiers were $0.
- You now own: DB backups (automated, but restores are yours), the S3⇄DB delete consistency, and Google token verification (~30 lines, no dashboard).
- Dropping Clerk removes a whole third-party dependency and the extension's clunkiest UX (hosted sign-in + Sync Session) — sign-in becomes invisible in the extension and one click in the web app.
- You lose: live query updates (accepted — focus refetch), the Convex dashboard (use any MySQL client).

## Order of work

Phases 1–4 are the bulk (the server). 5 and 6 are mechanical client swaps plus the one-time signing key + admin policy setup. 7 is optional. A sensible sequence for review checkpoints: **1+2 → 3+4 (server complete, testable with curl) → 5 → 6 → 8+9 (infra + pipeline) → 7+10**.
