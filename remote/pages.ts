// Login uses Supabase Auth UI (@supabase/auth-ui-react) via ESM CDN.
// Consent stays custom (OAuth approve/deny APIs are not part of Auth UI).

const SU = process.env.SUPABASE_URL ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';

const SHELL = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} - slashloop</title>
<style>
  :root { color-scheme: light; }
  * { font-family: Inter,system-ui,sans-serif; box-sizing: border-box; }
  body { background:#F1F2EF; color:#14181D; margin:0; min-height:100vh; display:grid; place-items:center; }
  .card { background:#fff; border:1px solid #E2E4DF; border-radius:14px; padding:28px; max-width:440px; width:calc(100% - 32px); }
  h1 { font-size:18px; margin:0 0 6px; }
  p { color:#3A424B; font-size:14px; line-height:1.5; margin:6px 0 16px; }
  .mono { font-family: 'IBM Plex Mono',monospace; font-size:12px; color:#6E7681; }
  button { cursor:pointer; border:none; border-radius:8px; padding:11px 16px; font-size:14px; font-weight:600; }
  .primary { background:#FF4D00; color:#fff; width:100%; }
  .ghost { background:transparent; color:#14181D; border:1px solid #E2E4DF; }
  .row { display:flex; gap:8px; }
  ul { margin:8px 0; padding-left:18px; }
  li { font-size:13px; color:#3A424B; }
  .err { color:#c0392b; font-size:13px; min-height:18px; }
  .logo { font-weight:800; font-size:16px; margin-bottom:8px; }
  .dot { color:#FF4D00; }
  #auth { margin-top:4px; }
  /* Align Auth UI primary with slashloop orange */
  #auth button[type="submit"] { background:#FF4D00 !important; }
</style>
</head>
<body><div class="card">${body}</div></body></html>`;

export function loginPage(): string {
  return SHELL('Sign in', `
    <div class="logo">slashloop<span class="dot">/</span></div>
    <h1>Sign in to authorize</h1>
    <p>Sign in to your slashloop account to approve AI-agent access.</p>
    <div id="auth"></div>
    <p class="err" id="err"></p>
    <script type="importmap">
    {
      "imports": {
        "react": "https://esm.sh/react@18.3.1",
        "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
        "react-dom": "https://esm.sh/react-dom@18.3.1",
        "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
        "@supabase/supabase-js": "https://esm.sh/@supabase/supabase-js@2.110.7",
        "@supabase/auth-ui-react": "https://esm.sh/@supabase/auth-ui-react@0.4.7?deps=react@18.3.1,react-dom@18.3.1,@supabase/supabase-js@2.110.7",
        "@supabase/auth-ui-shared": "https://esm.sh/@supabase/auth-ui-shared@0.1.8"
      }
    }
    </script>
    <script type="module">
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { createClient } from '@supabase/supabase-js';
      import { Auth } from '@supabase/auth-ui-react';
      import { ThemeSupa } from '@supabase/auth-ui-shared';

      const supabase = createClient(${JSON.stringify(SU)}, ${JSON.stringify(ANON)});
      const params = new URLSearchParams(location.search);
      const redirect = params.get('redirect') || '/';
      const redirectTo = location.origin + '/login?redirect=' + encodeURIComponent(redirect);
      const errEl = document.getElementById('err');

      // Already signed in (including return from Google OAuth).
      const { data: { user } } = await supabase.auth.getUser();
      if (user) { location.href = redirect; }

      supabase.auth.onAuthStateChange((event, session) => {
        if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
          if (event === 'SIGNED_IN') location.href = redirect;
        }
      });

      createRoot(document.getElementById('auth')).render(
        createElement(Auth, {
          supabaseClient: supabase,
          view: 'sign_in',
          providers: ['google', 'github'],
          redirectTo,
          onlyThirdPartyProviders: false,
          magicLink: false,
          showLinks: true,
          appearance: {
            theme: ThemeSupa,
            variables: {
              default: {
                colors: {
                  brand: '#FF4D00',
                  brandAccent: '#E04500',
                },
              },
            },
          },
          localization: {
            variables: {
              sign_in: {
                email_label: 'Email',
                password_label: 'Password',
                button_label: 'Sign in',
                social_provider_text: 'Continue with {{provider}}',
              },
            },
          },
        }),
      );
    </script>
  `);
}

export function consentPage(): string {
  return SHELL('Authorize', `
    <div class="logo">slashloop<span class="dot">/</span></div>
    <div id="state"><p class="mono">Loading authorization request...</p></div>
    <div id="ui" style="display:none">
      <h1 id="title">Authorize an app</h1>
      <p>An AI application wants to access your slashloop account.</p>
      <p><strong>App:</strong> <span id="client"></span></p>
      <p><strong>Redirect:</strong> <span id="redir" class="mono"></span></p>
      <div id="scopesWrap" style="display:none">
        <p><strong>Requested permissions:</strong></p>
        <ul id="scopes"></ul>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="primary" id="approve" style="flex:2">Approve</button>
        <button class="ghost" id="deny" style="flex:1">Deny</button>
      </div>
      <div class="err" id="err"></div>
    </div>
    <script type="module">
      import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';
      const supa = createClient(${JSON.stringify(SU)}, ${JSON.stringify(ANON)});
      const id = new URLSearchParams(location.search).get('authorization_id');
      const here = location.pathname + location.search;

      function friendlyError(error) {
        let code = error && error.code, msg = error && error.message;
        if (msg && msg.trim().charAt(0) === '{') {
          try { const p = JSON.parse(msg); code = code || p.code; msg = p.message || p.msg || msg; } catch (e) {}
        }
        if (code === 'oauth_authorization_not_found' || (msg || '').indexOf('authorization not found') >= 0) {
          return 'This authorization request expired or was already used. Close this tab and start a fresh connection from Claude Desktop.';
        }
        return msg || 'Something went wrong. Please reconnect from Claude Desktop.';
      }

      async function run() {
        if (!id) { document.getElementById('state').innerHTML = '<p class="err">Missing authorization_id.</p>'; return; }
        const { data: { user } } = await supa.auth.getUser();
        if (!user) { location.href = '/login?redirect=' + encodeURIComponent(here); return; }

        const { data, error } = await supa.auth.oauth.getAuthorizationDetails(id);
        if (error) { document.getElementById('state').innerHTML = '<p class="err">' + friendlyError(error) + '</p>'; return; }
        if (data && data.redirect_url && !data.client) { location.href = data.redirect_url; return; }

        document.getElementById('state').style.display = 'none';
        document.getElementById('ui').style.display = 'block';
        document.getElementById('title').textContent = 'Authorize ' + (data.client?.name || 'an app');
        document.getElementById('client').textContent = data.client?.name || 'Unknown';
        document.getElementById('redir').textContent = data.redirect_uri || '';
        const scopes = (data.scope || '').trim();
        if (scopes) {
          document.getElementById('scopesWrap').style.display = 'block';
          document.getElementById('scopes').innerHTML = scopes.split(' ')
            .map(function (s) { return '<li>' + s + '</li>'; }).join('');
        }

        let busy = false;
        async function decide(action) {
          if (busy) return;
          busy = true;
          const approveBtn = document.getElementById('approve');
          const denyBtn = document.getElementById('deny');
          approveBtn.disabled = true; denyBtn.disabled = true; approveBtn.textContent = 'Authorizing…';
          document.getElementById('err').textContent = '';
          const fn = action === 'approve' ? supa.auth.oauth.approveAuthorization : supa.auth.oauth.denyAuthorization;
          try {
            const { data: r, error } = await fn(id);
            if (error) {
              document.getElementById('err').textContent = friendlyError(error);
              busy = false; approveBtn.disabled = false; denyBtn.disabled = false; approveBtn.textContent = 'Approve';
              return;
            }
            location.href = r.redirect_url;
          } catch (e) {
            document.getElementById('err').textContent = friendlyError(e);
            busy = false; approveBtn.disabled = false; denyBtn.disabled = false; approveBtn.textContent = 'Approve';
          }
        }
        document.getElementById('approve').onclick = function () { decide('approve'); };
        document.getElementById('deny').onclick = function () { decide('deny'); };
      }
      run();
    </script>
  `);
}
