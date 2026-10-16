import { db } from '../db.js';
import { parseWorkspaceCategory, type WorkspaceCategory } from './source-format.js';

export async function workspaceCategoryOf(workspaceId: string): Promise<WorkspaceCategory> {
  const row = await db.workspace.findUnique({ where: { id: workspaceId }, select: { category: true } });
  return parseWorkspaceCategory(row?.category);
}
