// Dev-only mock OAuth provider for browser E2E testing of the site's OAuth login.
import http from 'node:http';
import { URL } from 'node:url';

const PORT = 3901;
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1:3901');
  if (url.pathname === '/authorize') {
    const redirect = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    res.writeHead(302, { Location: `${redirect}?code=e2e-code&state=${encodeURIComponent(state)}` });
    res.end();
  } else if (url.pathname === '/token') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ access_token: 'e2e-access-token' }));
  } else if (url.pathname === '/userinfo') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'e2e-user-1', username: 'E2E用户', email: 'e2e-oauth@example.com', email_verified: true }));
  } else {
    res.writeHead(404); res.end();
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`mock provider on http://127.0.0.1:${PORT}`));
