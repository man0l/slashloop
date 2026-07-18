import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleLogin } from '../remote/handlers.js';

export default (req: IncomingMessage, res: ServerResponse) => handleLogin(req, res);
