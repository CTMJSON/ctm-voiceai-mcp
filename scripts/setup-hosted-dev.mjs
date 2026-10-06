import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../deploy/', import.meta.url);
await mkdir(new URL('keycloak/', root), { recursive: true });
for (const name of ['.env','keycloak/voiceai-realm.json']) {
  try { await access(new URL(name, root)); throw new Error(`Refusing to overwrite deploy/${name}. Existing volumes and keys must stay consistent.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const password = () => randomBytes(24).toString('hex');
const alice = password(), bob = password();
const clientId = process.env.CTM_HOSTED_CLIENT_ID || 'replace-with-public-client-id';
if (!/^[\w-]+$/.test(clientId)) throw new Error('Invalid CTM_HOSTED_CLIENT_ID');
const env = {
  DB_ADMIN_PASSWORD: password(), DB_APP_PASSWORD: password(), KEYCLOAK_ADMIN_PASSWORD: password(),
  HOSTED_ENCRYPTION_KEY: randomBytes(32).toString('base64'), CTM_HOSTED_CLIENT_ID: clientId,
  TEST_ALICE_PASSWORD: alice, TEST_BOB_PASSWORD: bob
};
const realm = {
  realm: 'voiceai', enabled: true, sslRequired: 'none', registrationAllowed: false,
  bruteForceProtected: true, accessTokenLifespan: 900,
  clientScopes: [{ name: 'ctm-voiceai:use', protocol: 'openid-connect',
    attributes: { 'include.in.token.scope': 'true', 'display.on.consent.screen': 'true' },
    protocolMappers: [{ name: 'mcp-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
      config: { 'included.custom.audience': 'http://127.0.0.1:8000/mcp', 'access.token.claim': 'true', 'id.token.claim': 'false' } }]
  }],
  clients: [
    { clientId: 'voiceai-portal', name: 'VoiceAI connection portal', protocol: 'openid-connect', enabled: true, publicClient: true,
      standardFlowEnabled: true, directAccessGrantsEnabled: false,
      redirectUris: ['http://127.0.0.1:8000/oidc/callback'], webOrigins: ['http://127.0.0.1:8000'],
      attributes: { 'pkce.code.challenge.method': 'S256' }, defaultClientScopes: ['ctm-voiceai:use'] },
    // Password grant is limited to this loopback-only fixture client; never copy it into production.
    { clientId: 'voiceai-dev-test', protocol: 'openid-connect', enabled: true, publicClient: true,
      standardFlowEnabled: false, directAccessGrantsEnabled: true, defaultClientScopes: ['ctm-voiceai:use'] }
  ],
  users: [['alice','${TEST_ALICE_PASSWORD}'],['bob','${TEST_BOB_PASSWORD}']].map(([username,value]) => ({ username, enabled: true, emailVerified: true,
    firstName: username, lastName: 'Test', email: `${username}@example.test`,
    credentials: [{ type: 'password', value, temporary: false }] }))
};
await writeFile(new URL('.env', root), Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n', { mode: 0o600, flag:'wx' });
await writeFile(new URL('keycloak/voiceai-realm.json', root), JSON.stringify(realm,null,2)+'\n', { mode:0o644, flag:'wx' });
console.log(`Local development files created at ${fileURLToPath(root)}. No credentials printed. Set CTM_HOSTED_CLIENT_ID in deploy/.env before connecting CTM.`);
