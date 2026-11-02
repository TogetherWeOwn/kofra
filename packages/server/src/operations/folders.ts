import { z } from "zod";
import { deleteFolder } from "@kofra/core";
import { defineOperation } from "../operations";
import { DESTROY } from "./shared";

export const FOLDER_OPERATIONS = [defineOperation({
  id: "delete_folder",
  method: "DELETE",
  path: "/api/v1/folders/{folder}",
  summary: "Delete a folder",
  description: "Delete an empty or populated organizer folder. Its sites are kept and become unfiled. Set confirm to the folder's exact name.",
  toolset: "folders",
  scopes: ["sites:delete"],
  input: z.object({ folder: z.string().min(1), confirm: z.string().min(1) }),
  output: z.object({ deleted: z.boolean(), id: z.string() }),
  annotations: DESTROY,
  async handler(input, { dw, principal }) { return deleteFolder(dw, principal, input.folder, input.confirm); },
  examples: [{ input: { folder: "folder_example", confirm: "Projects" }, output: { deleted: true, id: "folder_example" } }],
})];
