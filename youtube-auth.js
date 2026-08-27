// One-time-consent OAuth flow for uploading to a single fixed YouTube
// account (basalvivek@gmail.com). See credentials/README.md for the
// Google Cloud setup this depends on.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { exec } = require('child_process');
const { google } = require('googleapis');

const ROOT = __dirname;
const CREDENTIALS_PATH = path.join(ROOT, 'credentials', 'client_secret.json');
const TOKEN_PATH = path.join(ROOT, 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

function loadClientCreds() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      'Missing credentials/client_secret.json — finish the Google Cloud setup ' +
      'in credentials/README.md first.'
    );
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const creds = raw.installed || raw.web;
  if (!creds || !creds.client_id || !creds.client_secret) {
    throw new Error('credentials/client_secret.json is missing client_id/client_secret');
  }
  return creds;
}

function buildOAuth2Client(redirectUri) {
  const creds = loadClientCreds();
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);
}

function getAuthStatus() {
  if (!fs.existsSync(TOKEN_PATH)) return { connected: false };
  try {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    return { connected: !!token.refresh_token };
  } catch {
    return { connected: false };
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => { /* best-effort; user can also copy the URL manually */ });
}

// Opens a loopback HTTP server on an ephemeral port, sends the user to
// Google's consent screen with that port as the redirect_uri (the
// "Desktop app" OAuth client type supports any localhost port), and
// resolves once the resulting refresh token is saved to token.json.
function startAuthFlow() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      fn(arg);
    };

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, 'http://localhost');
      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');

      // Only a request carrying `code` or `error` is the actual OAuth
      // redirect. Anything else hitting this ephemeral server (browsers
      // commonly fire an incidental GET /favicon.ico at the same origin)
      // must be ignored without closing the server or settling the
      // promise — otherwise that stray request gets treated as "the"
      // callback, showing a false success page while the real redirect
      // (arriving after) finds the server already closed.
      if (!code && !error) {
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        error
          ? `<h2>Authorization failed: ${error}</h2>You can close this tab.`
          : '<h2>YouTube account connected.</h2>You can close this tab and go back to MergeVideos.'
      );
      server.close();

      if (error) return finish(reject, new Error('Authorization denied: ' + error));

      const redirectUri = `http://localhost:${port}`;
      let oAuth2Client;
      try {
        oAuth2Client = buildOAuth2Client(redirectUri);
      } catch (err) {
        return finish(reject, err);
      }
      oAuth2Client.getToken(code)
        .then(({ tokens }) => {
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
          finish(resolve);
        })
        .catch((err) => finish(reject, err));
    });

    let port;
    const timeoutHandle = setTimeout(() => {
      server.close();
      finish(reject, new Error('Authorization timed out after 5 minutes'));
    }, 5 * 60 * 1000);

    server.on('error', (err) => finish(reject, err));

    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      let oAuth2Client;
      try {
        oAuth2Client = buildOAuth2Client(`http://localhost:${port}`);
      } catch (err) {
        server.close();
        return finish(reject, err);
      }
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES
      });
      openBrowser(authUrl);
    });
  });
}

async function getAuthorizedClient() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('YouTube account not connected yet — click "Connect YouTube Account" first.');
  }
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  const oAuth2Client = buildOAuth2Client();
  oAuth2Client.setCredentials(tokens);
  // googleapis auto-refreshes the access token from the refresh token;
  // persist whatever it refreshes so future runs don't re-prompt consent.
  oAuth2Client.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });
  return oAuth2Client;
}

// ---------------------------------------------------------------------
// Resumable upload
// ---------------------------------------------------------------------
// The `googleapis` package (googleapis-common/apirequest.js) only ever
// does a "multipart" or "media" upload: the entire file is piped through
// ONE single-shot HTTP request with no chunking, no resume, and no
// verification of what the server actually received. For a multi-GB
// merged video, any hiccup on that one connection (flaky Wi-Fi, a proxy,
// a VPN) either fails outright or — what was actually happening here —
// lets a truncated/reordered body through as a "successful" upload, which
// is exactly what produces a YouTube video with repeated, missing, or
// desynced sections while the local file (never touched again after
// merge) plays back perfectly fine.
//
// This implements YouTube's official resumable upload protocol instead:
// the file is sent as fixed byte-range chunks, and after any chunk
// failure we ask YouTube exactly how many bytes of the file it has
// actually received (via a status-check PUT) before resuming — so a
// retry always continues from the true offset instead of re-sending or
// skipping bytes.
const RESUMABLE_CHUNK_SIZE = 8 * 1024 * 1024; // must be a multiple of 256 KiB (except the final chunk)
const MAX_CHUNK_RETRIES = 5;

const MIME_BY_EXT = {
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg', '.3gp': 'video/3gpp', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t'
};

function mimeTypeFor(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function getFreshAccessToken(oAuth2Client) {
  // google-auth-library checks expiry internally and refreshes via the
  // stored refresh_token when needed, so this is cheap to call often.
  const result = await oAuth2Client.getAccessToken();
  const token = typeof result === 'string' ? result : result.token;
  if (!token) throw new Error('Could not obtain a YouTube access token — try reconnecting the account.');
  return token;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Asks YouTube how many bytes of the file it has actually received so
// far for this upload session, per the resumable-upload spec (a PUT with
// an unknown-length Content-Range and no body). Used to recover the true
// offset after a chunk PUT fails, instead of guessing.
async function queryResumableStatus(uploadUrl, accessToken, fileSize) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Range': `bytes */${fileSize}`
    }
  });
  if (res.status === 308) {
    const range = res.headers.get('range'); // e.g. "bytes=0-8388607"
    return { done: false, offset: range ? parseInt(range.split('-')[1], 10) + 1 : null };
  }
  if (res.status === 200 || res.status === 201) {
    return { done: true, body: await res.json() };
  }
  return { done: false, offset: null };
}

async function uploadVideoResumable(oAuth2Client, { filePath, fileSize, metadata, onProgress }) {
  let accessToken = await getFreshAccessToken(oAuth2Client);

  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeTypeFor(filePath),
        'X-Upload-Content-Length': String(fileSize)
      },
      body: JSON.stringify(metadata)
    }
  );
  if (!initRes.ok) {
    const text = await initRes.text().catch(() => '');
    throw new Error(`Could not start resumable upload session (HTTP ${initRes.status}): ${text.slice(0, 500)}`);
  }
  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube did not return a resumable upload session URL');

  const fd = fs.openSync(filePath, 'r');
  try {
    let offset = 0;
    let attempt = 0;

    while (offset < fileSize) {
      const chunkSize = Math.min(RESUMABLE_CHUNK_SIZE, fileSize - offset);
      const buffer = Buffer.alloc(chunkSize);
      fs.readSync(fd, buffer, 0, chunkSize, offset);

      try {
        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${offset}-${offset + chunkSize - 1}/${fileSize}`
          },
          body: buffer
        });

        if (putRes.status === 308) {
          // Chunk accepted. Trust YouTube's reported byte offset over our
          // own bookkeeping, in case it received less than we sent.
          const range = putRes.headers.get('range');
          offset = range ? parseInt(range.split('-')[1], 10) + 1 : offset + chunkSize;
          attempt = 0;
          if (onProgress) onProgress(offset);
          continue;
        }
        if (putRes.status === 200 || putRes.status === 201) {
          return await putRes.json();
        }
        if (putRes.status === 401) {
          accessToken = await getFreshAccessToken(oAuth2Client);
          throw new Error('Access token expired mid-upload');
        }
        const text = await putRes.text().catch(() => '');
        throw new Error(`Chunk upload failed (HTTP ${putRes.status}): ${text.slice(0, 500)}`);
      } catch (err) {
        attempt++;
        if (attempt > MAX_CHUNK_RETRIES) throw err;
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000));
        const status = await queryResumableStatus(uploadUrl, accessToken, fileSize).catch(() => ({ done: false, offset: null }));
        if (status.done) return status.body;
        if (status.offset !== null) offset = status.offset;
        // else: offset unknown — retry the same range as-is.
      }
    }
    throw new Error('Upload loop ended without a final response from YouTube');
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { getAuthStatus, startAuthFlow, getAuthorizedClient, uploadVideoResumable };
