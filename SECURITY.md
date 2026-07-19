# Security

Please report security issues privately through GitHub's security advisory
feature instead of opening a public issue. Do not include database files,
session contents, API keys, or other personal data in a report.

The application binds its HTTP server to `127.0.0.1` and opens external links
outside the Electron renderer. Renderer Node integration remains disabled.
