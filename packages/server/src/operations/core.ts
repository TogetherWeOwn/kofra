import { CORE_API_OPERATIONS } from "./core-api";
import { SITE_OPERATIONS } from "./sites";
import { VERSION_OPERATIONS } from "./versions";
import { KEY_OPERATIONS } from "./keys";
import { MEMBER_OPERATIONS } from "./members";
import { HTTP_OPERATIONS } from "./http";
import { TRANSFER_OPERATIONS } from "./transfers";
import { FOLDER_OPERATIONS } from "./folders";
import { UPLOAD_OPERATIONS } from "./uploads";

/** Stable core order: generated MCP tools and every legacy REST transport. */
export const CORE_OPERATIONS = [...CORE_API_OPERATIONS, ...SITE_OPERATIONS, ...VERSION_OPERATIONS, ...UPLOAD_OPERATIONS, ...KEY_OPERATIONS, ...MEMBER_OPERATIONS, ...FOLDER_OPERATIONS, ...HTTP_OPERATIONS, ...TRANSFER_OPERATIONS];
