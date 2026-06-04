# Security Policy

## Supported versions

`penstock` is pre-1.0 software. Security fixes are applied to the latest
published `0.x` release. Once `1.0.0` ships, this policy will be updated to
describe a defined support window.

| Version | Supported |
| ------- | --------- |
| 0.x     | ✅        |

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public
issue, pull request, or discussion for them.

- **Preferred:** use GitHub's private vulnerability reporting on this repository
  (the **Security** tab → **Report a vulnerability**).
- **Alternatively:** email **zaier8284@gmail.com** with a description, affected
  version(s), and steps to reproduce.

You can expect an initial acknowledgement within **5 business days**. Once an
issue is confirmed, a fix and a coordinated disclosure will be arranged, and
your contribution credited if you wish.

## Scope

`penstock` has **zero runtime dependencies**, performs no network or filesystem
I/O, and executes no dynamic code — its attack surface is intentionally small.
Reports about the library's own runtime behaviour (for example prototype
pollution or unsafe name handling) are especially welcome.
