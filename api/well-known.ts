import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleWellKnown, originFrom } from '../remote/handlers.js';

export default (req: IncomingMessage, res: ServerResponse) =>
  handleWellKnown(req, res, originFrom(req));
