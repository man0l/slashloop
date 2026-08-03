// GET /.well-known/oauth-protected-resource, /login, /oauth/consent, /health, /
//
// One file, not four — see api/sources.ts for why (Hobby plan's 12-function
// cap). vercel.json rewrites each path here with a `page` query param.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleHealth, handleWellKnown, handleLogin, handleConsent, originFrom } from '../remote/handlers.js';

export default (req: IncomingMessage, res: ServerResponse) => {
  const page = new URL(req.url ?? '', 'http://localhost').searchParams.get('page');
  switch (page) {
    case 'well-known':
      return handleWellKnown(req, res, originFrom(req));
    case 'login':
      return handleLogin(req, res);
    case 'consent':
      return handleConsent(req, res);
    default:
      return handleHealth(req, res, originFrom(req));
  }
};
