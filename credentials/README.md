# YouTube upload credentials — one-time setup

`client_secret.json` goes in this folder (it's gitignored — never commit it).

1. Go to https://console.cloud.google.com/ and create (or select) a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**
   - Publishing status: **Testing**
   - Test users: add `basalvivek@gmail.com`
   - Scope: `https://www.googleapis.com/auth/youtube.upload`
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app**
5. Download the JSON for that client, save it here as
   `credentials/client_secret.json`.
6. Start the app, click **Connect YouTube Account** on the merge
   result — a browser tab opens for Google consent. Approve as
   `basalvivek@gmail.com`. A `token.json` is saved in the project root
   (also gitignored) so you only do this once per machine.
