# FiveM Optimizer Updates With GitHub Releases

Use GitHub Releases as the update host. The installed app only needs a public
download URL. Do not put a GitHub token in app code, `.env`, `update-config.json`,
or any shipped file.

The update feed URL format is:

```text
https://github.com/OWNER/REPO/releases/latest/download/
```

This project is currently set up for:

```text
https://github.com/stacks-opti/test-sub/releases/latest/download/
```

## One-Time Setup

1. Create a GitHub repo for the app.
2. Install GitHub CLI from `https://cli.github.com/`.
3. Log in:
   ```bat
   gh auth login
   ```
4. Build and publish the first release:
   ```bat
   publish-github-release.bat
   ```
5. At the version prompt, leave it blank unless you want to change the app version.
6. At the repo prompt, press Enter to use `stacks-opti/test-sub`.
7. Install the generated setup exe from `dist`.
8. Run:
   ```bat
   configure-github-updates.bat
   ```
9. Press Enter at both prompts to use `stacks-opti` and `test-sub`.
10. Restart the app.

`gh auth login` stores publisher auth in the GitHub CLI credential store on your
developer machine. That credential is not bundled into the installer and is not
needed by customers.

You can also paste this URL inside Settings > Update Feed URL:

```text
https://github.com/stacks-opti/test-sub/releases/latest/download/
```

## Publishing A New Update

1. Increase `version` in `package.json`, for example `2.0.0` to `2.0.1`.
2. Run:
   ```bat
   publish-github-release.bat
   ```
3. Enter the new version at the version prompt, for example `1.1.0`.
4. Press Enter at the repo prompt to use `stacks-opti/test-sub`.
5. In the installed app, go to Settings and click `Check for App Updates`.
6. Wait for the download.
7. Click `Install Update`.

Users install once from the setup `.exe`. After that, new versions are delivered
through the app's Settings > App Updates panel.

## What The Publish Script Uploads

The script builds the app, creates or updates the matching release tag, and uploads:

- `dist/latest.yml`
- `dist/FiveM Optimizer Setup x.x.x.exe`
- `dist/FiveM Optimizer Setup x.x.x.exe.blockmap`

## Important Rules

- The GitHub release must include `latest.yml`.
- The file names inside `latest.yml` must match the uploaded asset names exactly.
- Updates only work in the packaged installer app, not from `npm start`.
- Public GitHub repos work without tokens in the app after `gh auth login` on the publisher machine.
- Private repos need extra auth handling and are not recommended for simple auto-updates.
- `update-config.json` should contain only the public feed URL, for example:
  ```json
  {
    "url": "https://github.com/stacks-opti/test-sub/releases/latest/download/"
  }
  ```
- Keep `.env`, `.env.*`, generated installers, and logs uncommitted. `.gitignore`
  already excludes them.

## Token-Safe Design

- Publisher token: handled by GitHub CLI locally through `gh auth login`.
- Installed app: reads only a public release URL.
- Update checks: download `latest.yml`, the setup `.exe`, and the `.blockmap`.
- Customer install: no token, no GitHub login, no secret file.
