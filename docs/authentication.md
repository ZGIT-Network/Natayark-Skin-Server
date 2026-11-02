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

An existing local email alone never signs into an account that has a local password. The original PHP plugin matched accounts by email and stored no provider subject. A passwordless account can be bound directly on its first sign-in only when the configured provider explicitly asserts that the matching email is verified. An unverified or missing assertion still requires proof through the original mailbox; an empty local password is not ownership proof. This also applies to the Natayark ID preset, which has no documented email-verification assertion.

The distinction between an email value and proof of control follows the [`email_verified` claim in OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html#StandardClaims); subsequent authentication uses the stable provider subject.

All other previously unbound identities that match an existing address open **确认原有账户** at `/auth/oauth/migrate`. The owner confirms either the original password or a one-use link delivered exclusively to the original database email. This flow also works when registration or local website password login is disabled.

The challenge and pending link belong to the initiating browser and expire after one hour. Password verification is repeated under the user lock; email verification rechecks the original address and account status. The flow and challenge are consumed atomically. Successful migration adds the stable identity and browser session, and successful mailbox proof marks the email verified: the original UID, password, players, UUIDs, textures and score are retained. Subsequent logins use the provider subject even if its email changes. An existing authenticated user can also bind explicitly under **登录方式与应用**. A user who has neither the original password nor access to the original mailbox needs operator-assisted ownership recovery; an unverified email assertion from a provider cannot replace that proof.

Unbinding requires another currently usable login method. When local website password login is disabled, a saved password does not replace the final configured external provider. Removed providers do not count. Concurrent unlinks retain at least one usable method, and unbinding revokes browser sessions. Authorization state is browser-bound, expires after ten minutes, is consumed once, and never carries a client secret in the authorization URL.

## Mail, password recovery and compatibility

Configure `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_FROM_ADDRESS`, and optional `MAIL_USERNAME` / `MAIL_PASSWORD`. Natayark registration, an unverified email from another provider, password recovery, and email changes require working outbound mail. No reset link is exposed in the browser when SMTP is missing. The integration suite uses a loopback SMTP trap and sends nothing to real mailboxes.

`node scripts/import-legacy-mail-config.mjs /path/to/reference-site` imports missing SMTP values from the supplied site's `.env`; `LEGACY_DIR` is an alternative. It backs up the current file and never sends a message or prints a credential. Existing explicitly configured values are retained. Successful real delivery still needs verification.

Local login accepts email or original player name through `email` or `identification`. **记住登录** (`keep=true`) enables a seven-day persistent cookie; without it the browser cookie lasts for the browser session, with the same server-side expiry ceiling. Cookies are HttpOnly and SameSite=Lax. Original `_token` / `X-CSRF-Token` inputs are accepted when they contain this application's valid CSRF token; old Laravel sessions still require a new login.

Registration and password recovery require CAPTCHA; login requires it after four failed password attempts from the same effective IP. The local JPEG endpoint `/auth/captcha` issues a browser-bound, ten-minute, single-use challenge and stores only its answer hash. Refresh invalidates the previous image. reCAPTCHA v2 can instead be configured under **注册与角色** using `recaptcha_sitekey` / `recaptcha_secretkey`; `recaptcha_invisible` selects invisible mode. The secret is never echoed into HTML, empty password inputs retain it, and clearing the site key returns to local CAPTCHA. Verification uses a server-side POST, validates the returned hostname, and fails closed on remote errors. See [Google's verification contract](https://developers.google.com/recaptcha/docs/verify).

The invisible widget executes after native form validation and submits once after proof. Failure or expiry restores the submit control. Client callbacks are defined before the async API loads. The checkbox uses compact mode on narrow screens and both modes follow light/dark changes. Browser checks use a local implementation of the documented Google client API and loopback server verification; they do not establish acceptance by the real Google service.

Mailbox/reset challenges are stored as SHA-256 token hashes, expire after one hour and are single-use. Email changes require the current password when present and proof of ownership of the new mailbox. Changing/resetting a password revokes existing web sessions and OAuth access/refresh tokens. Browser logout revokes its stored session; replaying its previous cookie fails.

Preserve the legacy `PWD_METHOD` and `SALT` values when sharing the database with PHP. Supported ciphers mirror `oldbf/app/Services/Cipher`: `BCRYPT`, `PHP_PASSWORD_HASH`, `ARGON2I`, `MD5`, `SHA256`, `SHA512`, `SALTED2MD5`, `SALTED2SHA256`, and `SALTED2SHA512`. Bcrypt writes retain the `$2y$` prefix; Argon2i/id strings can be verified. New hashes follow the configured legacy algorithm so PHP can continue reading them. Existing Laravel browser cookies are not imported; users sign in again after cutover.

Production requires an unpredictable persistent `APP_KEY`, HTTPS `PUBLIC_ORIGIN`, and `NODE_ENV=production`. Production session cookies are Secure, HttpOnly and SameSite=Lax. Anonymous CSRF cookies are browser-specific and do not create database session rows. Public game and token APIs do not create anonymous web cookies.

## Verification

`node --import tsx --test tests/auth.test.ts tests/auth.integration.test.ts` verifies legacy password vectors, session tampering and expiry, CSRF isolation, free first-player registration, concurrent daily sign-in, mocked OAuth PKCE and state replay, stable identity binding/unbinding, mailbox registration, and password-reset/session revocation. Integration tests require a `DB_TABLE_PREFIX` beginning with `dev_`, mutate only that namespace and clean up their test users. They are not evidence of a completed login against the real external providers.
