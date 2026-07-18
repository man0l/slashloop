import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleHealth, originFrom } from '../remote/handlers.js';

export default (req: IncomingMessage, res: ServerResponse) =>
  handleHealth(req, res, originFrom(req));
