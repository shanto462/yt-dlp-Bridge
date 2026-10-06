# Contributing

Thanks for helping. Bug reports, fixes, and small focused features are all welcome.

## Before you start

- For a bug, open an issue with the **Copy Log** output (menu bar → the download → Copy Log). Remove personal paths first if you like.
- For a new feature, open an issue first so we can agree on the idea before you write code.
- For a security problem, read [SECURITY.md](SECURITY.md) and report it privately.

## Set up

You need macOS, Node.js 20 or later, and `brew install yt-dlp ffmpeg deno` for real downloads.

```bash
npm install                 # Playwright, for icons and the end-to-end test
npm --prefix app install    # Electron and electron-builder
npm --prefix app start      # run the menu bar app from source
```

Load the `extension` folder in Chrome with **Load unpacked** (see the README).

## Checks

Run these before you open a pull request. CI runs the first two on every pull request.

```bash
npm test                    # unit and API tests, no network, about 1 second
npm run build:extension     # checks the manifest and every extension script
npm run e2e                 # real app + extension + yt-dlp, needs network
```

## Rules for changes

- **Never pass raw flags from the extension.** Every new option is a fixed choice, a boolean, or a strict pattern in `app/src/options.js`, with a test in `app/test/options.test.js`.
- **Keep both sides in sync.** A new download option goes in `DEFAULTS` in both `app/src/options.js` and `extension/lib/settings.js`. A test fails if they differ.
- **Keep the API locked down.** Calls that start or read downloads stay `POST`, so Chrome sends the extension's `Origin`.
- **No new runtime dependencies** in the app or the extension without a good reason. Both use only Node and Chrome built-ins today.
- **Update the README** when you add a setting or change how something works.
- **Version bumps** change both `extension/manifest.json` and `app/package.json`.

## Pull requests

- Keep each pull request to one change, with a short title in the imperative ("Add Opus quality presets").
- Say how you tested it. Screenshots help for UI changes.
- The maintainer reviews every pull request before it is merged. CI for first-time and outside contributors starts after the maintainer approves the run.

By contributing, you agree that your work is released under the [MIT License](LICENSE).
