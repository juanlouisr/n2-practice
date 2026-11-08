# Backlog

## Sync progress across devices

Keep progress in the user's own Google Drive, in the hidden app-data folder (`drive.appdata`
scope: the app sees only its own folder, and the file doesn't show in Drive).

- **Sign-in:** "Sign in with Google" once per device in Settings → Sync, using Google
  Identity Services' token flow. Tokens last about an hour; renew with one tap.
- **When:** sync on open, after each finished set, and when the tab is hidden. Show "Last
  synced …" and a Sync now button.
- **Merge:** make the answer log the source of truth.
  - Combine the logs from all devices and drop duplicates by time and question id, as Import
    already does.
  - Work out per-question results, retry lists and Progress from the merged log.
  - Answers from before the log existed: keep the per-question entry with the latest `last`.
  - Settings: the newest change wins.
  - Merging this way gives the same result however often it runs, so two devices syncing at
    once only needs a later sync to settle.
- **Setup:** an OAuth web client and a consent screen in testing mode, in a personal Google
  Cloud project, with the owner as the only test user. The client ID is public, so it can
  live in the repo. First sign-in shows Google's "unverified app" warning.
- **Considered instead:** a secret GitHub Gist (needs a pasted classic token that can reach
  every gist), Firebase or Supabase (another backend to run), QR transfer (still manual).
  Export/Import stays as a backup.
