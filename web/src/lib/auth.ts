// Sign-in. Live mode: Keycloak OIDC (authorization code + PKCE) on the same origin (/auth).
// Demo mode: no sign-in; the console acts as a chosen demo user ("view as").
import type Keycloak from 'keycloak-js';

export const DEMO = import.meta.env.PUBLIC_TEMS_DEMO !== 'false';
const DEMO_AS_KEY = 'tems-demo-as';

let kc: Keycloak | null = null;
let ready: Promise<void> | null = null;

export function initAuth(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    if (DEMO) return;
    const { default: KC } = await import('keycloak-js');
    kc = new KC({ url: `${location.origin}/auth`, realm: 'tems', clientId: 'tems-admin' });
    await kc.init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false, responseMode: 'query' });
    // strip ?state=&code= left by the redirect
    if (/[?&](state|code|session_state)=/.test(location.search)) history.replaceState(null, '', location.pathname);
    setInterval(() => { kc?.updateToken(60).catch(() => kc?.login()); }, 30_000);
  })();
  return ready;
}

export async function token(): Promise<string> {
  await initAuth();
  if (!kc) return 'demo';
  await kc.updateToken(30).catch(() => kc!.login());
  return kc.token ?? '';
}

export function logout() {
  if (DEMO) { try { localStorage.removeItem(DEMO_AS_KEY); } catch {} location.href = '/'; return; }
  kc?.logout({ redirectUri: location.origin });
}

export function accountConsoleUrl(): string {
  return DEMO ? '#' : (kc?.createAccountUrl() ?? '/auth/realms/tems/account');
}

export function demoAs(): string | null { try { return localStorage.getItem(DEMO_AS_KEY); } catch { return null; } }
export function setDemoAs(id: string) { try { localStorage.setItem(DEMO_AS_KEY, id); } catch {} }
