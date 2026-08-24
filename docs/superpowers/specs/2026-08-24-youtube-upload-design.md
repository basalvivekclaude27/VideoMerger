# YouTube Upload — Design

## Purpose

After a merge job finishes, let the user upload the final compressed
video straight to YouTube (account: basalvivek@gmail.com) from the
app UI, without leaving the tool or manually re-uploading through
YouTube's website.

## Non-goals

- Multi-account support — single fixed Google account only.
- Editing/deleting/managing videos already on YouTube.
- Auto-upload without user review of title/description (rejected during
  brainstorming in favor of explicit per-upload metadata entry).

## Prerequisites (one-time, done by the user in Google Cloud Console)

1. Create (or reuse) a Google Cloud project.
2. Enable the **YouTube Data API v3** for that project.
3. Configure the OAuth consent screen: type "External", publishing
   status "Testing", add `basalvivek@gmail.com` as a test user, scope
   `https://www.googleapis.com/auth/youtube.upload`.
4. Create an OAuth client ID of type **Desktop app**.
5. Download the client credentials JSON, save as
   `credentials/client_secret.json` in the project root.

`credentials/` and `token.json` are added to `.gitignore` — these are
secrets and must never be committed.

## Architecture

```
Browser (public/app.js)
   │  "Connect YouTube account" / "Upload to YouTube" (title, desc, tags, privacy)
   ▼
server.js
   │  googleapis (google-auth-library OAuth2Client + youtube('v3'))
   ▼
YouTube Data API v3 (videos.insert, resumable upload)
```

### Auth module (`youtube-auth.js`, new file)

- Loads `credentials/client_secret.json` (client id/secret + the
  fixed loopback redirect URI Google issues for "Desktop app" clients).
- `getAuthStatus()` — returns whether `token.json` exists and holds a
  refresh token.
- `startAuthFlow()` — spins up a one-shot local HTTP server on an
  ephemeral port, builds the Google consent URL with that port as the
  loopback redirect, opens it in the system's default browser
  (`start` on Windows via `exec`), waits for the redirect carrying the
  `code` query param, exchanges it for tokens via
  `oAuth2Client.getToken(code)`, writes `{ refresh_token, ... }` to
  `token.json`, closes the local server.
- `getAuthorizedClient()` — loads `token.json`, sets credentials on an
  `OAuth2Client`, returns it (the `googleapis` client library
  auto-refreshes the access token from the refresh token as needed).

### Upload module (in `server.js`, alongside the existing merge pipeline)

- `uploads` Map, same shape/pattern as the existing `jobs` Map
  (`{ percent, status, message, videoId, videoUrl }`), keyed by a
  generated `uploadId`.
- `POST /api/youtube/upload` — body `{ outputPath, title, description,
  tags, privacyStatus }`.
  - Validates `outputPath` is a file that exists (must be a path this
    server itself produced — reject anything outside `destFolder`
    territory the way `/api/generate` already validates clip
    filenames, to avoid an arbitrary-file-read/upload vector).
  - Validates `title` non-empty (YouTube requires it), `privacyStatus`
    ∈ `{private, unlisted, public}`.
  - Kicks off `youtube.videos.insert` with `part: 'snippet,status'`,
    `media.body: fs.createReadStream(outputPath)`. The client library
    performs a resumable upload automatically for files of this size.
  - `onUploadProgress` (googleapis supports a progress callback via
    the underlying gaxios request) updates `uploads.set(uploadId,
    {percent, ...})`.
  - Responds immediately with `{ uploadId }`; upload runs async, same
    fire-and-poll pattern as `/api/generate`.
- `GET /api/youtube/upload-progress/:uploadId` — same shape as
  `/api/progress/:jobId`.
- `GET /api/youtube/auth-status` — `{ connected: boolean }`.
- `GET /api/youtube/authorize` — triggers `startAuthFlow()`, responds
  once consent completes (or errors/times out after 5 minutes).

## Data flow

1. Merge job reaches `status: 'done'` (existing pipeline, unchanged).
2. UI shows "Upload to YouTube" button next to the success alert.
3. Click → UI calls `GET /api/youtube/auth-status`.
   - Not connected → show "Connect YouTube account" button first;
     clicking calls `GET /api/youtube/authorize` and waits (spinner)
     for the browser consent round-trip to finish.
   - Connected → show the metadata form directly.
4. Metadata form: title (required, prefilled blank), description
   (optional), tags (optional, comma-separated), privacy dropdown
   (default **Public**, options private/unlisted/public).
5. Submit → `POST /api/youtube/upload` with `outputPath` = the
   `outputPath` already returned by the merge job's `/api/progress`
   response.
6. UI polls `/api/youtube/upload-progress/:uploadId` every 1s (same
   pattern as merge progress), shows a progress bar.
7. On `status: 'done'`, show a success alert with a clickable
   `https://youtu.be/<videoId>` link. On `status: 'error'`, show the
   error message (quota exceeded, network failure, invalid file, etc.)
   in the same alert pattern used for merge errors.

## Error handling

- No `credentials/client_secret.json` present → `/api/youtube/authorize`
  returns a clear error telling the user to finish the Google Cloud
  setup steps above.
- Consent flow times out or user closes the browser tab without
  approving → `/api/youtube/authorize` returns an error; UI shows it,
  user can retry.
- Upload fails (quota exceeded, network drop, file missing) →
  `uploads` entry set to `status: 'error'` with the underlying message;
  UI surfaces it, no partial/corrupt state left server-side beyond the
  read stream simply stopping.
- `outputPath` validation rejects paths that aren't a file that exists
  on disk, so the upload endpoint can't be pointed at arbitrary server
  files.

## Testing

- Manual: run a real merge, connect the YouTube account (one-time
  consent), upload the resulting file with a test title as
  **Private**, confirm it appears in YouTube Studio under
  basalvivek@gmail.com, then delete the test video from YouTube.
- Unit-level (where practical without hitting the real API): metadata
  validation (empty title rejected, invalid privacyStatus rejected,
  outputPath-not-a-file rejected) can be tested by calling the route
  handler logic directly with a fake `googleapis` client.
- No automated test hits the real YouTube API (would burn quota and
  leave real videos behind) — auth/upload correctness is verified
  manually per the steps above.

## Dependencies

- `googleapis` (npm) — official Google API client, includes
  `google-auth-library` for OAuth2Client and typed `youtube('v3')`
  bindings with built-in resumable upload support.

## Files touched

- `package.json` — add `googleapis` dependency.
- `.gitignore` — add `credentials/`, `token.json`.
- `youtube-auth.js` — new, OAuth flow + token storage.
- `server.js` — new routes: `/api/youtube/auth-status`,
  `/api/youtube/authorize`, `/api/youtube/upload`,
  `/api/youtube/upload-progress/:uploadId`.
- `public/index.html` — upload button + metadata form markup
  (hidden until a merge job is done).
- `public/app.js` — wire up auth-status check, connect flow, upload
  form submit, progress polling, success/error display.
