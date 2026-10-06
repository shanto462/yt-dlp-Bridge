# Security policy

yt-dlp Bridge runs a local HTTP API on your Mac and starts programs (yt-dlp, ffmpeg) for a browser extension. Bugs in that boundary matter, so thank you for reporting them privately.

## Supported versions

Only the latest release on `main` gets security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: go to the [Security tab](https://github.com/shanto462/yt-dlp-Bridge/security) and click **Report a vulnerability**. Include:

- what an attacker can do, and what they need first (for example "any web page", "another installed extension", "local user")
- steps to reproduce, or a proof of concept
- the app version (menu bar → the first line of the menu) and your macOS and Chrome versions

You should get a first reply within 7 days. Once a fix is ready, it is released and the advisory is published with credit to you, unless you ask not to be named.

## What is in scope

- The local API in `app/src/server.js`: Host and Origin checks, extension approval, request limits
- Option checks and the yt-dlp argument builder in `app/src/options.js`: anything that lets a caller pass raw flags, run another program, or write outside the chosen folder
- The browser extension in `extension/`

## What is out of scope

- Bugs in yt-dlp or ffmpeg themselves. Report those to [yt-dlp](https://github.com/yt-dlp/yt-dlp/security) or [FFmpeg](https://ffmpeg.org/security.html).
- Attacks that need an extension you already allowed in the app, or full control of your user account. An allowed extension is trusted by design.
- Missing code signing or notarization. The app is built from source and signed ad hoc on your own Mac.
