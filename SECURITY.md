# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in OpenLiDARViewer, please report it
**privately** rather than opening a public issue. Email **info@aurtech.mx**
with:

- a description of the issue,
- steps to reproduce it, and
- the affected version or commit.

You can expect an acknowledgement and, where applicable, a fix or mitigation
plan.

## Local-first data handling

OpenLiDARViewer is designed around local-first inspection. Scan files are read,
parsed, and rendered entirely in the browser — there is no server to upload
them to. This makes it suitable for confidential survey data. The security of
your data also depends on how and where you choose to deploy and run the app.

## Do not post sensitive data publicly

When reporting a bug, **do not attach confidential or proprietary scan data**
to public GitHub issues. Provide a minimal, non-sensitive sample, or describe
the file structure instead.

## Supported versions

OpenLiDARViewer is an R&D-stage project. Security fixes are applied to the
latest version on the default branch.

| Version | Supported |
|---|---|
| Latest (`main`) | Yes |
| Older versions | Best effort |
