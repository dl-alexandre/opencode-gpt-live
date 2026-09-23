# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/malhashemi/opencode-gpt-live/security/advisories/new),
not in a public issue. Include steps to reproduce and the version you tested.

You can expect an acknowledgement within a few days. Once a fix is ready, it ships in a release and the advisory is
published with credit to you, unless you prefer otherwise.

## Scope

Areas where a flaw would matter most:

- **Credentials.** The server plugin reads your ChatGPT sign-in from OpenCode and sends it only to OpenAI. It must never
  reach the native helper, logs or other sessions.
- **The native helper download.** When no platform package is installed, the plugin downloads `gpt-live-host` from the
  GitHub release and refuses to run it unless its SHA-256 matches the release's `SHA256SUMS`.
- **The voice agent's reach.** The voice session's tools act only on the session the call was started from, and are
  hidden from every other session.
- **Local files.** Call logs are written under your user state directory.

## Supported versions

Security fixes go into the latest release.
