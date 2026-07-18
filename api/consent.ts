import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleConsent } from '../remote/handlers.js';

export default (req: IncomingMessage, res: ServerResponse) => handleConsent(req, res);
