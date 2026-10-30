import { getOptionBool } from './option.js';
import { identitiesOf, loadProviders, resolveProviderEnv } from './oauth-client.js';

/** Count configured website login methods rather than merely stored bindings. */
export async function loginMethods(uid: number, password: string) {
  const providers = (await loadProviders()).filter(provider => resolveProviderEnv(provider.clientId) &&
    (provider.tokenAuthMethod === 'none' || resolveProviderEnv(provider.clientSecret)));
  const keys = new Set(providers.map(provider => provider.key));
  const identities = await identitiesOf(uid);
  const local = !!password && await getOptionBool('local_login_enabled', true);
  return {
    local, identities,
    canUnlink: (provider: string) => local || identities.some(identity => identity.provider !== provider && keys.has(identity.provider)),
  };
}
