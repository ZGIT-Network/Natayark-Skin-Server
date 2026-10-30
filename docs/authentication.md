# Authentication and OAuth migration

The Node application reads the existing `users`, `players`, `uuid`, `options` and `oauth_*` tables. `migrations/001_auth_extensions.sql` adds four separate tables for revocable browser sessions, stable external identities, one-use OAuth state, and expiring mailbox challenges. It does not alter legacy columns.

## External login and registration

Configure providers in the administration settings under `oauth_providers`, or use the environment presets:

| Provider | Credentials | Callback |
| --- | --- | --- |
| Natayark ID | `NYKID_KEY`, `NYKID_SECRET` | `<PUBLIC_ORIGIN>/auth/login/natayarkid/callback` |
| Microsoft Live | `LIVE_KEY`, `LIVE_SECRET` | `<PUBLIC_ORIGIN>/auth/login/live/callback` |

Register the exact callback with the provider. `PUBLIC_ORIGIN` overrides the old database `site_url` for callback generation in a local development copy. The old `NYKID_REDIRECT_URI` / `LIVE_REDIRECT_URI` environment values are reference configuration; callbacks are generated from the configured public origin so a production URI cannot accidentally capture local test logins.

Natayark's authorization, token and user-info endpoints and `data.id` / `data.username` / `data.email` mapping come from the supplied PHP provider at `oldbf/plugins/oauth-natayark/vendor/littleskinchina/bs-socialite-provider-littleskin/Provider.php`. That provider documents neither PKCE nor an `email_verified` assertion; its preset keeps the confidential client-secret exchange, with `pkce: false`. Its real deployment still needs a successful live provider acceptance test. Microsoft Live's preset uses Microsoft identity v2, Graph `User.Read`, and PKCE S256.

A configurable provider accepts:

```json
{
  "key": "example",
  "displayName": "Example account",
  "authUrl": "https://id.example/authorize",
  "tokenUrl": "https://id.example/token",
  "userUrl": "https://id.example/userinfo",
  "clientId": "${EXAMPLE_CLIENT_ID}",
  "clientSecret": "${EXAMPLE_CLIENT_SECRET}",
  "scope": "profile email",
  "userIdField": "sub",
  "usernameField": "name",
  "emailField": "email",
  "emailVerifiedField": "email_verified",
  "pkce": true,
  "tokenAuthMethod": "client_secret_post"
}
```

`emailVerifiedField` must name an actual provider assertion. A missing value, `false`, or the string `"true"` does not count as proof. `tokenAuthMethod` can also be `client_secret_basic` or `none`; public clients must use PKCE. Production endpoints must use HTTPS. Only loopback HTTP endpoints are permitted in development for local integration fixtures.

The callback first looks up `(provider, subject)`. For an unbound subject, the user completes the email and initial player information. A verified provider email can complete registration immediately; other addresses require a one-use mailbox verification link. User, free first player, UUID, registration-share reward and identity are created in one transaction. No partially registered account is created before mailbox proof.

An existing local email is never sufficient to sign into that account. Sign into the original account, then use **登录方式与应用 → 绑定**. The old PHP OAuth plugin stored only email and did not retain the provider subject. Consequently, historical OAuth-only accounts need mailbox recovery to establish a local password before first binding, or a separately verified subject mapping imported by the operator. There is no trustworthy subject mapping to infer from the old email column alone. This is a migration prerequisite for those accounts.

Unbinding the final login method is prevented while the account has no password. Unbinding revokes existing web sessions. Subsequent logins use the stable subject even if the provider email changes. State is browser-bound, expires after ten minutes, is consumed once, and never carries a client secret in the authorization URL.

## Mail, password recovery and compatibility

Configure `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_FROM_ADDRESS`, and optional `MAIL_USERNAME` / `MAIL_PASSWORD`. Natayark registration, an unverified email from another provider, password recovery, and email changes require working outbound mail. No reset link is exposed in the browser when SMTP is missing. The integration suite uses a loopback SMTP trap and sends nothing to real mailboxes.

Mailbox/reset challenges are stored as SHA-256 token hashes, expire after one hour and are single-use. Email changes require the current password when present and proof of ownership of the new mailbox. Changing/resetting a password revokes existing web sessions and OAuth access/refresh tokens. Browser logout revokes its stored session; replaying its previous cookie fails.

Preserve the legacy `PWD_METHOD` and `SALT` values when sharing the database with PHP. Supported ciphers mirror `oldbf/app/Services/Cipher`: `BCRYPT`, `PHP_PASSWORD_HASH`, `ARGON2I`, `MD5`, `SHA256`, `SHA512`, `SALTED2MD5`, `SALTED2SHA256`, and `SALTED2SHA512`. Bcrypt writes retain the `$2y$` prefix; Argon2i/id strings can be verified. New hashes follow the configured legacy algorithm so PHP can continue reading them. Existing Laravel browser cookies are not imported; users sign in again after cutover.

Production requires an unpredictable persistent `APP_KEY`, HTTPS `PUBLIC_ORIGIN`, and `NODE_ENV=production`. Production session cookies are Secure, HttpOnly and SameSite=Lax. Anonymous CSRF cookies are browser-specific and do not create database session rows. Public game and token APIs do not create anonymous web cookies.

## Verification

`node --import tsx --test tests/auth.test.ts tests/auth.integration.test.ts` verifies legacy password vectors, session tampering and expiry, CSRF isolation, free first-player registration, concurrent daily sign-in, mocked OAuth PKCE and state replay, stable identity binding/unbinding, mailbox registration, and password-reset/session revocation. Integration tests require a `DB_TABLE_PREFIX` beginning with `dev_`, mutate only that namespace and clean up their test users. They are not evidence of a completed login against the real external providers.
