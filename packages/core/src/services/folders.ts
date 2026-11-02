import type { KofraContext } from "../context";
import type { Principal } from "../principal";
import { requireMember } from "../principal";
import { forbidden, notFound } from "../errors";
import { requireConfirm } from "./site-ops";

/** Removing an organizer never deletes its sites; they become unfiled. */
export async function deleteFolder(dc: KofraContext, p: Principal, id: string, confirm: string) {
  const member = requireMember(p, "sites:delete");
  if (member.siteId) throw forbidden("A single-site key cannot delete folders.", "Use an unrestricted member key.", "key_site_restricted");
  const folder = await dc.env.DB.prepare("SELECT id, name FROM folders WHERE tenant_id = ? AND id = ?").bind(member.tenantId, id).first<{ id: string; name: string }>();
  if (!folder) throw notFound("folder_not_found", "No folder that this key can access.", "List your folders and retry.");
  requireConfirm(confirm, folder.name, "the folder's name");
  await dc.env.DB.batch([
    dc.env.DB.prepare("UPDATE sites SET folder_id = NULL WHERE folder_id = ? AND tenant_id = ?").bind(folder.id, member.tenantId),
    dc.env.DB.prepare("DELETE FROM folders WHERE id = ? AND tenant_id = ?").bind(folder.id, member.tenantId),
  ]);
  return { deleted: true, id: folder.id };
}
