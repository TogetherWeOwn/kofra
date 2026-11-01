// DO NOT EDIT: generated from the operation registry by `npm run client:generate` (R-45).
import { DropwayHttpClient, type BytesResult, type CallOptions } from "./http.ts";

export type WhoamiInput = Record<string, unknown>;

export interface WhoamiOutput {
  principal?: string;
  tenant?: Record<string, unknown>;
  member?: Record<string, unknown>;
  keyId?: string;
  scopes?: string[];
  siteRestriction?: string | null;
  capabilities?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PublishSiteInput {
  /** Every file of the site. Omit when archiveUrl is given. */
  files?: ({
    /** Path in the site, e.g. "index.html", "assets/app.js". Omit for attachments. */
    path?: string;
    /** Attachment URL (public https, like url); pair with file_name. */
    download_url?: string;
    /** Attachment name; becomes the path. */
    file_name?: string;
    /** Inline: "utf8" up to 1 MB, "base64" up to 256 KB; prefer url/sha256 when bigger or binary. */
    content?: string;
    /** Content encoding. Default "utf8". */
    encoding?: "utf8" | "base64";
    /** Public https URL (URL_FETCH_MAX_BYTES default 100 MiB; 30 s, 3 redirects; other caps). */
    url?: string;
    /** Headers for the url download; used once, never stored. */
    headers?: Record<string, string>;
    /** Hex SHA-256. Stored bytes are reused; otherwise an upload link is returned (PUT, then finalize_version). */
    sha256?: string;
    /** Bytes; required with an unstored sha256. */
    size?: number;
    /** Copy a published file: site you can read (default: this site), version (default: live), path (default: same). */
    copyFrom?: {
      /** Site slug, site_... id or URL. */
      site?: string;
      /** "live", "v3"/"3", or a ver_... id. */
      version?: string;
      path?: string;
    };
    /** MIME type; default from extension. */
    contentType?: string;
  })[];
  /** Public https .zip to unpack, instead of files (never both). */
  archiveUrl?: string;
  /** Optional. Slug, id or URL of your existing site to replace, or a new slug (3-56 chars: a-z, 0-9, single hyphens). */
  site?: string;
  /** Title shown in lists. */
  title?: string | null;
  /** About the site, briefly. */
  description?: string | null;
  /** Serve index.html for unknown paths (SPA). */
  spa?: boolean;
  /** Render .md as pages (default true); false serves raw. */
  renderMarkdown?: boolean;
  /** COOP/COEP headers (threaded WASM). */
  crossOriginIsolation?: boolean;
  /** Skip search indexing. */
  noindex?: boolean;
  /** Optional visitor password (see set_site_access). */
  password?: string;
  /** Short note about this version, like a commit message. */
  message?: string;
  /** Fail with version_conflict if the live version is no longer this one (protects someone else's newer publish). */
  baseVersionId?: string;
}

export interface PublishSiteOutput {
  status: "live" | "unchanged" | "awaiting_upload";
  /** Live URL. Share it exactly as returned. */
  url: string;
  slug: string;
  /** 24 h signed preview; bearer capability. */
  versionUrl?: string;
  site?: {
    slug: string;
    url: string;
    currentVersionId?: string | null;
    [key: string]: unknown;
  };
  version?: Record<string, unknown> | null;
  files?: Record<string, unknown>;
  /** Only for awaiting_upload: items to PUT, then finalize. */
  upload?: Record<string, unknown>;
  warnings?: {
    code?: string;
    message?: string;
    path?: string;
    line?: number;
    fix?: string;
    [key: string]: unknown;
  }[];
  next?: unknown[];
  [key: string]: unknown;
}

export interface UpdateSiteFilesInput {
  files?: ({
    path?: string;
    /** Chat attachment URL fetched like url; pair with file_name. */
    download_url?: string;
    /** Chat attachment file name; becomes the path. */
    file_name?: string;
    content?: string;
    encoding?: "utf8" | "base64";
    /** Public https URL the server downloads. */
    url?: string;
    headers?: Record<string, string>;
    sha256?: string;
    size?: number;
    copyFrom?: {
      site?: string;
      version?: string;
      path?: string;
      [key: string]: unknown;
    };
    contentType?: string;
    [key: string]: unknown;
  })[];
  delete?: string[];
  move?: {
    from: string;
    to: string;
    [key: string]: unknown;
  }[];
  /** "live", "v3", "3" or a version id. */
  baseVersionId?: string;
  message?: string;
  slug: string;
  [key: string]: unknown;
}

export interface UpdateSiteFilesOutput {
  status?: "live" | "unchanged" | "awaiting_upload";
  url?: string;
  slug?: string;
  /** 24 h signed preview; bearer capability. */
  versionUrl?: string;
  site?: {
    slug?: string;
    /** Share this URL as returned; never construct it. */
    url?: string;
    title?: string | null;
    description?: string | null;
    anonymous?: boolean;
    expiresAt?: string | null;
    settings?: Record<string, unknown>;
    currentVersionId?: string | null;
    currentVersion?: {
      id?: string;
      number?: number;
      status?: "pending" | "ready";
      live?: boolean;
      fileCount?: number;
      totalBytes?: number;
      source?: string;
      client?: string | null;
      message?: string | null;
      createdAt?: string;
      finalizedAt?: string | null;
      [key: string]: unknown;
    } | null;
    createdAt?: string;
    updatedAt?: string;
    links?: Record<string, unknown>;
    id?: string;
    [key: string]: unknown;
  };
  version?: {
    id?: string;
    number?: number;
    status?: "pending" | "ready";
    live?: boolean;
    fileCount?: number;
    totalBytes?: number;
    source?: string;
    client?: string | null;
    message?: string | null;
    createdAt?: string;
    finalizedAt?: string | null;
    [key: string]: unknown;
  } | null;
  files?: {
    total?: number;
    stored?: number;
    reused?: number;
    fetched?: number;
    pending?: number;
    [key: string]: unknown;
  };
  upload?: {
    versionId?: string;
    expiresAt?: string;
    items?: Record<string, unknown>[];
    finalize?: Record<string, unknown>;
    [key: string]: unknown;
  };
  changes?: Record<string, unknown>;
  warnings?: {
    code?: string;
    message?: string;
    path?: string;
    line?: number;
    fix?: string;
    [key: string]: unknown;
  }[];
  next?: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface FinalizeVersionInput {
  slug: string;
  id: string;
  [key: string]: unknown;
}

export type FinalizeVersionOutput = Record<string, unknown>;

export interface GetSiteInput {
  slug: string;
  [key: string]: unknown;
}

export interface GetSiteOutput {
  site?: {
    slug?: string;
    /** Share this URL as returned; never construct it. */
    url?: string;
    title?: string | null;
    description?: string | null;
    anonymous?: boolean;
    expiresAt?: string | null;
    settings?: Record<string, unknown>;
    currentVersionId?: string | null;
    currentVersion?: {
      id?: string;
      number?: number;
      status?: "pending" | "ready";
      live?: boolean;
      fileCount?: number;
      totalBytes?: number;
      source?: string;
      client?: string | null;
      message?: string | null;
      createdAt?: string;
      finalizedAt?: string | null;
      [key: string]: unknown;
    } | null;
    createdAt?: string;
    updatedAt?: string;
    links?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ListSitesInput {
  limit?: number;
  cursor?: string;
  [key: string]: unknown;
}

export interface ListSitesOutput {
  sites?: ({
    slug?: string;
    /** Share this URL as returned; never construct it. */
    url?: string;
    title?: string | null;
    description?: string | null;
    anonymous?: boolean;
    expiresAt?: string | null;
    settings?: Record<string, unknown>;
    currentVersionId?: string | null;
    currentVersion?: {
      id?: string;
      number?: number;
      status?: "pending" | "ready";
      live?: boolean;
      fileCount?: number;
      totalBytes?: number;
      source?: string;
      client?: string | null;
      message?: string | null;
      createdAt?: string;
      finalizedAt?: string | null;
      [key: string]: unknown;
    } | null;
    createdAt?: string;
    updatedAt?: string;
    links?: Record<string, unknown>;
    [key: string]: unknown;
  })[];
  nextCursor?: string | null;
  [key: string]: unknown;
}

export interface ListFilesInput {
  slug: string;
  version?: string;
  [key: string]: unknown;
}

export type ListFilesOutput = Record<string, unknown>;

export interface ReadFileInput {
  /** Site slug, site_... id or URL. */
  site: string;
  /** File path, e.g. "index.html". */
  path: string;
  /** "live", "v3"/"3", or a ver_... id. */
  version?: string;
  /** Default "auto". */
  encoding?: "auto" | "text" | "base64";
  /** Byte offset to start at. Default 0. */
  offset?: number;
  /** Bytes to read. Default 65536. */
  length?: number;
}

export interface ReadFileOutput {
  path: string;
  versionId?: string;
  contentType?: string;
  kind?: string;
  size: number;
  sha256?: string;
  encoding: string;
  offset?: number;
  length?: number;
  truncated?: boolean;
  nextOffset?: number | null;
  content: string;
  url?: string;
  rawUrl?: string;
  [key: string]: unknown;
}

export interface ListVersionsInput {
  slug: string;
  limit?: number;
  [key: string]: unknown;
}

export type ListVersionsOutput = Record<string, unknown>;

export interface RestoreVersionInput {
  slug: string;
  id: string;
  [key: string]: unknown;
}

export type RestoreVersionOutput = Record<string, unknown>;

export interface UpdateSiteSettingsInput {
  title?: string | null;
  description?: string | null;
  /** Serve index.html for unknown paths (single-page apps). */
  spa?: boolean;
  /** Render .md files as HTML pages for browsers (default true). */
  renderMarkdown?: boolean;
  /** Send COOP/COEP headers (needed for SharedArrayBuffer, threaded WASM). */
  crossOriginIsolation?: boolean;
  /** Ask crawlers not to index this site (X-Robots-Tag: noindex, generated robots.txt). */
  noindex?: boolean;
  /** Visitor password; null removes it. Needs an API key. */
  password?: string | null;
  slug: string;
  [key: string]: unknown;
}

export interface UpdateSiteSettingsOutput {
  site?: {
    slug?: string;
    /** Share this URL as returned; never construct it. */
    url?: string;
    title?: string | null;
    description?: string | null;
    anonymous?: boolean;
    expiresAt?: string | null;
    settings?: Record<string, unknown>;
    currentVersionId?: string | null;
    currentVersion?: {
      id?: string;
      number?: number;
      status?: "pending" | "ready";
      live?: boolean;
      fileCount?: number;
      totalBytes?: number;
      source?: string;
      client?: string | null;
      message?: string | null;
      createdAt?: string;
      finalizedAt?: string | null;
      [key: string]: unknown;
    } | null;
    createdAt?: string;
    updatedAt?: string;
    links?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SetSiteAccessInput {
  mode: "public" | "password" | "restricted" | "private";
  password?: string;
  slug: string;
  [key: string]: unknown;
}

export interface SetSiteAccessOutput {
  site?: {
    slug?: string;
    /** Share this URL as returned; never construct it. */
    url?: string;
    title?: string | null;
    description?: string | null;
    anonymous?: boolean;
    expiresAt?: string | null;
    settings?: Record<string, unknown>;
    currentVersionId?: string | null;
    currentVersion?: {
      id?: string;
      number?: number;
      status?: "pending" | "ready";
      live?: boolean;
      fileCount?: number;
      totalBytes?: number;
      source?: string;
      client?: string | null;
      message?: string | null;
      createdAt?: string;
      finalizedAt?: string | null;
      [key: string]: unknown;
    } | null;
    createdAt?: string;
    updatedAt?: string;
    links?: Record<string, unknown>;
    [key: string]: unknown;
  };
  access?: {
    mode?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface DeleteSiteInput {
  slug: string;
  [key: string]: unknown;
}

export type DeleteSiteOutput = Record<string, unknown>;

export interface ClaimSiteInput {
  claimToken: string;
  slug: string;
  [key: string]: unknown;
}

export type ClaimSiteOutput = Record<string, unknown>;

export interface CreateSiteInput {
  slug?: string;
  files?: {
    path: string;
    size: number;
    sha256: string;
    contentType?: string;
    [key: string]: unknown;
  }[];
  title?: string | null;
  description?: string | null;
  /** Serve index.html for unknown paths (single-page apps). */
  spa?: boolean;
  /** Render .md files as HTML pages for browsers (default true). */
  renderMarkdown?: boolean;
  /** Send COOP/COEP headers (needed for SharedArrayBuffer, threaded WASM). */
  crossOriginIsolation?: boolean;
  /** Ask crawlers not to index this site (X-Robots-Tag: noindex, generated robots.txt). */
  noindex?: boolean;
  /** Visitor password; null removes it. Needs an API key. */
  password?: string | null;
  [key: string]: unknown;
}

export interface CreateSiteOutput {
  site?: {
    slug?: string;
    /** Share this URL as returned; never construct it. */
    url?: string;
    title?: string | null;
    description?: string | null;
    anonymous?: boolean;
    expiresAt?: string | null;
    settings?: Record<string, unknown>;
    currentVersionId?: string | null;
    currentVersion?: {
      id?: string;
      number?: number;
      status?: "pending" | "ready";
      live?: boolean;
      fileCount?: number;
      totalBytes?: number;
      source?: string;
      client?: string | null;
      message?: string | null;
      createdAt?: string;
      finalizedAt?: string | null;
      [key: string]: unknown;
    } | null;
    createdAt?: string;
    updatedAt?: string;
    links?: Record<string, unknown>;
    [key: string]: unknown;
  };
  url?: string;
  claimToken?: string;
  deploy?: {
    unchanged?: boolean;
    deploy?: {
      id?: string;
      number?: number;
      status?: "pending" | "ready";
      live?: boolean;
      fileCount?: number;
      totalBytes?: number;
      source?: string;
      client?: string | null;
      message?: string | null;
      createdAt?: string;
      finalizedAt?: string | null;
      [key: string]: unknown;
    };
    missing?: string[];
    uploads?: {
      sha256?: string;
      size?: number;
      paths?: string[];
      method?: "PUT";
      url?: string;
      headers?: Record<string, unknown>;
      [key: string]: unknown;
    }[];
    finalizeUrl?: string | null;
    /** Plain-English next step. */
    next?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface RenameSiteInput {
  newSlug: string;
  slug: string;
  [key: string]: unknown;
}

export interface RenameSiteOutput {
  renamed?: boolean;
  oldSlug?: string;
  slug?: string;
  url?: string;
  redirectUntil?: string | null;
  site?: {
    slug?: string;
    /** Share this URL as returned; never construct it. */
    url?: string;
    title?: string | null;
    description?: string | null;
    anonymous?: boolean;
    expiresAt?: string | null;
    settings?: Record<string, unknown>;
    currentVersionId?: string | null;
    currentVersion?: {
      id?: string;
      number?: number;
      status?: "pending" | "ready";
      live?: boolean;
      fileCount?: number;
      totalBytes?: number;
      source?: string;
      client?: string | null;
      message?: string | null;
      createdAt?: string;
      finalizedAt?: string | null;
      [key: string]: unknown;
    } | null;
    createdAt?: string;
    updatedAt?: string;
    links?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface DuplicateSiteInput {
  /** Site slug, site_... id or URL. */
  site: string;
  /** 3-56 chars: a-z, 0-9, single hyphens. */
  newSlug: string;
  /** Version message for the copy's first version. */
  message?: string;
}

export interface DuplicateSiteOutput {
  slug: string;
  url: string;
  site?: {
    slug: string;
    url: string;
    currentVersionId?: string | null;
    [key: string]: unknown;
  };
  versionId: string;
  fileCount: number;
  totalBytes: number;
  note?: string;
  [key: string]: unknown;
}

export interface ReleaseSlugInput {
  slug: string;
  reason: string;
  confirm: string;
  [key: string]: unknown;
}

export interface ReleaseSlugOutput {
  released?: boolean;
  slug?: string;
  redirectsReleased?: number;
  holdsReleased?: number;
  reason?: string;
  [key: string]: unknown;
}

export interface GetVersionInput {
  slug: string;
  id: string;
  [key: string]: unknown;
}

export interface GetVersionOutput {
  site?: string;
  version?: {
    id?: string;
    number?: number;
    status?: "pending" | "ready";
    live?: boolean;
    fileCount?: number;
    totalBytes?: number;
    source?: string;
    client?: string | null;
    message?: string | null;
    createdAt?: string;
    finalizedAt?: string | null;
    [key: string]: unknown;
  };
  missing?: string[];
  upload?: {
    versionId?: string;
    expiresAt?: string;
    items?: {
      path?: string;
      paths?: string[];
      sha256?: string;
      size?: number;
      method?: "PUT";
      url?: string;
      headers?: Record<string, string>;
      curl?: string;
      [key: string]: unknown;
    }[];
    [key: string]: unknown;
  };
  uploads?: {
    path?: string;
    paths?: string[];
    sha256?: string;
    size?: number;
    method?: "PUT";
    url?: string;
    headers?: Record<string, string>;
    curl?: string;
    [key: string]: unknown;
  }[];
  [key: string]: unknown;
}

export interface DeleteVersionInput {
  slug: string;
  id: string;
  /** Must equal the site's slug (destructive confirmation). */
  confirm: string;
  [key: string]: unknown;
}

export type DeleteVersionOutput = Record<string, unknown>;

export interface ExportVersionInput {
  slug: string;
  version: string;
  [key: string]: unknown;
}

export type ExportVersionOutput = Record<string, unknown>;

export interface CreateMultipartUploadInput {
  /** Pending version id returned with status awaiting_upload. */
  versionId: string;
  /** SHA-256 of the whole file, as listed in the pending manifest. */
  sha256: string;
  /** Part size in bytes, 10485760-99614720; default 52428800. */
  partSize?: number;
}

export interface CreateMultipartUploadOutput {
  id: string;
  versionId?: string;
  sha256: string;
  size: number;
  partSize: number;
  parts: {
    partNumber: number;
    size: number;
    etag: string;
    [key: string]: unknown;
  }[];
  status?: string;
  expiresAt?: string;
  [key: string]: unknown;
}

export interface GetMultipartUploadInput {
  /** Upload session id from POST /api/v1/uploads. */
  id: string;
}

export interface GetMultipartUploadOutput {
  id: string;
  versionId?: string;
  sha256: string;
  size: number;
  partSize: number;
  parts: {
    partNumber: number;
    size: number;
    etag: string;
    [key: string]: unknown;
  }[];
  status?: string;
  expiresAt?: string;
  [key: string]: unknown;
}

export interface UploadMultipartPartInput {
  id: string;
  /** One-based part number. */
  partNumber: number;
}

export interface UploadMultipartPartOutput {
  partNumber: number;
  size: number;
  etag: string;
  [key: string]: unknown;
}

export interface CompleteMultipartUploadInput {
  id: string;
  /** Ignored; the server uses its acknowledged parts. */
  parts?: Record<string, unknown>[];
}

export interface CompleteMultipartUploadOutput {
  sha256: string;
  size: number;
  stored?: boolean;
  [key: string]: unknown;
}

export interface ListApiKeysInput {
  all?: "1" | "true";
  [key: string]: unknown;
}

export type ListApiKeysOutput = Record<string, unknown>;

export interface CreateApiKeyInput {
  name?: string;
  scopes?: ("sites:read" | "sites:write" | "sites:delete" | "keys:write" | "members:write" | "data:write" | "secrets:write" | "admin")[] | string;
  expiresInDays?: number;
  memberId?: string;
  site?: string;
  [key: string]: unknown;
}

export type CreateApiKeyOutput = Record<string, unknown>;

export interface RevokeApiKeyInput {
  id: string;
  [key: string]: unknown;
}

export type RevokeApiKeyOutput = Record<string, unknown>;

export type ListMembersInput = Record<string, unknown>;

export type ListMembersOutput = Record<string, unknown>;

export interface AddMemberInput {
  email?: string;
  name?: string;
  role?: "owner" | "admin" | "member";
  scopes?: ("sites:read" | "sites:write" | "sites:delete" | "keys:write" | "members:write" | "data:write" | "secrets:write" | "admin")[] | string;
  [key: string]: unknown;
}

export type AddMemberOutput = Record<string, unknown>;

export interface UpdateMemberInput {
  id: string;
  [key: string]: unknown;
}

export type UpdateMemberOutput = Record<string, unknown>;

export interface RemoveMemberInput {
  id: string;
  [key: string]: unknown;
}

export type RemoveMemberOutput = Record<string, unknown>;

export interface DeleteFolderInput {
  folder: string;
  confirm: string;
}

export interface DeleteFolderOutput {
  deleted: boolean;
  id: string;
}

export type ApiIndexInput = Record<string, unknown>;

export type ApiIndexOutput = Record<string, unknown>;

export interface SetupInstanceInput {
  email?: string;
  name?: string;
  tenantName?: string;
  [key: string]: unknown;
}

export type SetupInstanceOutput = Record<string, unknown>;

export type RecoverOwnerKeyInput = Record<string, unknown>;

export type RecoverOwnerKeyOutput = Record<string, unknown>;

export interface PublishUploadInput {
  /** Legacy alias for site. */
  slug?: string;
  /** Existing site ref or new slug. */
  site?: string;
  files?: ({
    path?: string;
    /** Chat attachment URL fetched like url; pair with file_name. */
    download_url?: string;
    /** Chat attachment file name; becomes the path. */
    file_name?: string;
    content?: string;
    encoding?: "utf8" | "base64";
    /** Public https URL the server downloads. */
    url?: string;
    headers?: Record<string, string>;
    sha256?: string;
    size?: number;
    copyFrom?: {
      site?: string;
      version?: string;
      path?: string;
      [key: string]: unknown;
    };
    contentType?: string;
    [key: string]: unknown;
  })[];
  /** JSON only: public https .zip URL to publish instead of files. */
  archiveUrl?: string;
  message?: string;
  baseVersionId?: string;
  title?: string | null;
  description?: string | null;
  /** Serve index.html for unknown paths (single-page apps). */
  spa?: boolean;
  /** Render .md files as HTML pages for browsers (default true). */
  renderMarkdown?: boolean;
  /** Send COOP/COEP headers (needed for SharedArrayBuffer, threaded WASM). */
  crossOriginIsolation?: boolean;
  /** Visitor password; null removes it. Needs an API key. */
  password?: string | null;
  path?: string;
  [key: string]: unknown;
}

export type PublishUploadOutput = {
  status?: "live" | "unchanged" | "awaiting_upload";
  url?: string;
  slug?: string;
  /** 24 h signed preview; bearer capability. */
  versionUrl?: string;
  site?: {
    slug?: string;
    /** Share this URL as returned; never construct it. */
    url?: string;
    title?: string | null;
    description?: string | null;
    anonymous?: boolean;
    expiresAt?: string | null;
    settings?: Record<string, unknown>;
    currentVersionId?: string | null;
    currentVersion?: {
      id?: string;
      number?: number;
      status?: "pending" | "ready";
      live?: boolean;
      fileCount?: number;
      totalBytes?: number;
      source?: string;
      client?: string | null;
      message?: string | null;
      createdAt?: string;
      finalizedAt?: string | null;
      [key: string]: unknown;
    } | null;
    createdAt?: string;
    updatedAt?: string;
    links?: Record<string, unknown>;
    id?: string;
    [key: string]: unknown;
  };
  version?: {
    id?: string;
    number?: number;
    status?: "pending" | "ready";
    live?: boolean;
    fileCount?: number;
    totalBytes?: number;
    source?: string;
    client?: string | null;
    message?: string | null;
    createdAt?: string;
    finalizedAt?: string | null;
    [key: string]: unknown;
  } | null;
  files?: {
    total?: number;
    stored?: number;
    reused?: number;
    fetched?: number;
    pending?: number;
    [key: string]: unknown;
  };
  upload?: {
    versionId?: string;
    expiresAt?: string;
    items?: Record<string, unknown>[];
    finalize?: Record<string, unknown>;
    [key: string]: unknown;
  };
  changes?: Record<string, unknown>;
  warnings?: {
    code?: string;
    message?: string;
    path?: string;
    line?: number;
    fix?: string;
    [key: string]: unknown;
  }[];
  next?: Record<string, unknown>[];
  [key: string]: unknown;
} | {
  url?: string;
  slug?: string;
  /** Signed exact-version preview link, valid for 24 hours. */
  versionUrl?: string;
  created?: boolean;
  unchanged?: boolean;
  site?: {
    slug?: string;
    /** Share this URL as returned; never construct it. */
    url?: string;
    title?: string | null;
    description?: string | null;
    anonymous?: boolean;
    expiresAt?: string | null;
    settings?: Record<string, unknown>;
    currentVersionId?: string | null;
    currentVersion?: {
      id?: string;
      number?: number;
      status?: "pending" | "ready";
      live?: boolean;
      fileCount?: number;
      totalBytes?: number;
      source?: string;
      client?: string | null;
      message?: string | null;
      createdAt?: string;
      finalizedAt?: string | null;
      [key: string]: unknown;
    } | null;
    createdAt?: string;
    updatedAt?: string;
    links?: Record<string, unknown>;
    [key: string]: unknown;
  };
  version?: {
    id?: string;
    number?: number;
    status?: "pending" | "ready";
    live?: boolean;
    fileCount?: number;
    totalBytes?: number;
    source?: string;
    client?: string | null;
    message?: string | null;
    createdAt?: string;
    finalizedAt?: string | null;
    [key: string]: unknown;
  };
  files?: string[];
  uploaded?: number;
  reused?: number;
  warnings?: {
    code?: string;
    message?: string;
    path?: string;
    line?: number;
    fix?: string;
    [key: string]: unknown;
  }[];
  /** Anonymous publishes only; shown once. */
  claimToken?: string;
  expiresAt?: string | null;
  [key: string]: unknown;
};

export interface CreateVersionInput {
  files: {
    path: string;
    size: number;
    sha256: string;
    contentType?: string;
    [key: string]: unknown;
  }[];
  message?: string;
  /** Fail with 409 version_conflict if the live version is no longer this one. */
  baseVersionId?: string;
  title?: string | null;
  description?: string | null;
  /** Serve index.html for unknown paths (single-page apps). */
  spa?: boolean;
  /** Render .md files as HTML pages for browsers (default true). */
  renderMarkdown?: boolean;
  /** Send COOP/COEP headers (needed for SharedArrayBuffer, threaded WASM). */
  crossOriginIsolation?: boolean;
  /** Visitor password; null removes it. Needs an API key. */
  password?: string | null;
  slug: string;
  [key: string]: unknown;
}

export interface CreateVersionOutput {
  unchanged?: boolean;
  deploy?: {
    id?: string;
    number?: number;
    status?: "pending" | "ready";
    live?: boolean;
    fileCount?: number;
    totalBytes?: number;
    source?: string;
    client?: string | null;
    message?: string | null;
    createdAt?: string;
    finalizedAt?: string | null;
    [key: string]: unknown;
  };
  missing?: string[];
  uploads?: {
    sha256?: string;
    size?: number;
    paths?: string[];
    method?: "PUT";
    url?: string;
    headers?: Record<string, unknown>;
    [key: string]: unknown;
  }[];
  finalizeUrl?: string | null;
  /** Plain-English next step. */
  next?: string;
  [key: string]: unknown;
}

export interface GetDeployInput {
  slug: string;
  id: string;
  [key: string]: unknown;
}

export type GetDeployOutput = Record<string, unknown>;

export interface UploadBlobInput {
  sha256: string;
  [key: string]: unknown;
}

export type UploadBlobOutput = Record<string, unknown>;

export interface GetFileBytesInput {
  slug: string;
  path: string;
  version?: string;
  [key: string]: unknown;
}

export type GetFileBytesOutput = Record<string, unknown>;

export interface CreateTransferInput {
  slug?: string;
  files: Record<string, unknown>[];
  /** Up to 50 normalized distinct email addresses; links are returned, not mailed. */
  recipients?: string[];
  /** Plain text, at most 10,000 characters. */
  message?: string | null;
  /** 8-1,024 characters without NUL; empty or null clears protection. */
  password?: string | null;
  /** Unix milliseconds, from one hour to the instance's transfer expiry ceiling. */
  expiresAt?: number;
  /** 1-10,000 counted downloads across all files and links; null means unlimited. */
  downloadLimit?: number | null;
}

export interface CreateTransferOutput {
  id: string;
  slug: string;
  mode: "transfer";
  url: string;
  expiresAt: number;
  [key: string]: unknown;
}

export interface GetTransferInput {
  transfer: string;
}

export interface GetTransferOutput {
  id: string;
  slug: string;
  mode: "transfer";
  url: string;
  expiresAt: number;
  [key: string]: unknown;
}

export interface UpdateTransferInput {
  transfer: string;
  /** Up to 50 normalized distinct email addresses; links are returned, not mailed. */
  recipients?: string[];
  /** Plain text, at most 10,000 characters. */
  message?: string | null;
  /** 8-1,024 characters without NUL; empty or null clears protection. */
  password?: string | null;
  /** Unix milliseconds, from one hour to the instance's transfer expiry ceiling. */
  expiresAt?: number;
  /** 1-10,000 counted downloads across all files and links; null means unlimited. */
  downloadLimit?: number | null;
  currentPassword?: string;
}

export interface UpdateTransferOutput {
  id: string;
  slug: string;
  mode: "transfer";
  url: string;
  expiresAt: number;
  [key: string]: unknown;
}

export interface RevokeTransfersInput {
  ids?: string[];
  allLive?: boolean;
}

export interface RevokeTransfersOutput {
  count: number;
}

export type ListOperationsInput = Record<string, unknown>;

export interface ListOperationsOutput {
  operations: Record<string, unknown>[];
}

export const OPERATIONS = {
  "whoami": { method: "GET", path: "/api/v1/me", summary: "Who am I" },
  "publish_site": { method: "POST", path: "/api/v1/publish-sources", summary: "Publish a site" },
  "update_site_files": { method: "PATCH", path: "/api/v1/sites/{slug}/files", summary: "Change some files" },
  "finalize_version": { method: "POST", path: "/api/v1/sites/{slug}/versions/{id}/finalize", summary: "Make an uploaded version live" },
  "get_site": { method: "GET", path: "/api/v1/sites/{slug}", summary: "Get a site" },
  "list_sites": { method: "GET", path: "/api/v1/sites", summary: "List sites" },
  "list_files": { method: "GET", path: "/api/v1/sites/{slug}/files", summary: "List files" },
  "read_file": { method: "GET", path: "/api/v1/read-file", summary: "Read a file" },
  "list_versions": { method: "GET", path: "/api/v1/sites/{slug}/versions", summary: "List versions" },
  "restore_version": { method: "POST", path: "/api/v1/sites/{slug}/versions/{id}/restore", summary: "Restore version" },
  "update_site_settings": { method: "PATCH", path: "/api/v1/sites/{slug}", summary: "Change site settings" },
  "set_site_access": { method: "PUT", path: "/api/v1/sites/{slug}/access", summary: "Set who can open a site" },
  "delete_site": { method: "DELETE", path: "/api/v1/sites/{slug}", summary: "Delete a site" },
  "claim_site": { method: "POST", path: "/api/v1/sites/{slug}/claim", summary: "Claim an anonymous site" },
  "create_site": { method: "POST", path: "/api/v1/sites", summary: "Create an empty site" },
  "rename_site": { method: "POST", path: "/api/v1/sites/{slug}/rename", summary: "Rename a site" },
  "duplicate_site": { method: "POST", path: "/api/v1/sites/{site}/duplicate", summary: "Duplicate a site's live version into a new slug" },
  "release_slug": { method: "POST", path: "/api/v1/slugs/release", summary: "Release a held site name early" },
  "get_version": { method: "GET", path: "/api/v1/sites/{slug}/versions/{id}", summary: "Get a version" },
  "delete_version": { method: "DELETE", path: "/api/v1/sites/{slug}/versions/{id}", summary: "Delete version" },
  "export_version": { method: "GET", path: "/api/v1/sites/{slug}/versions/{version}/export", summary: "Download a version as a ZIP" },
  "create_multipart_upload": { method: "POST", path: "/api/v1/uploads", summary: "Start or resume a multipart upload" },
  "get_multipart_upload": { method: "GET", path: "/api/v1/uploads/{id}", summary: "Show a resumable upload's acknowledged parts" },
  "upload_multipart_part": { method: "PUT", path: "/api/v1/uploads/{id}/parts/{partNumber}", summary: "Upload one part's raw bytes" },
  "complete_multipart_upload": { method: "POST", path: "/api/v1/uploads/{id}/complete", summary: "Complete and verify a resumable upload" },
  "list_api_keys": { method: "GET", path: "/api/v1/keys", summary: "List API keys" },
  "create_api_key": { method: "POST", path: "/api/v1/keys", summary: "Create an API key" },
  "revoke_api_key": { method: "DELETE", path: "/api/v1/keys/{id}", summary: "Revoke an API key" },
  "list_members": { method: "GET", path: "/api/v1/members", summary: "List members" },
  "add_member": { method: "POST", path: "/api/v1/members", summary: "Add a member" },
  "update_member": { method: "PATCH", path: "/api/v1/members/{id}", summary: "Change a member" },
  "remove_member": { method: "DELETE", path: "/api/v1/members/{id}", summary: "Remove a member" },
  "delete_folder": { method: "DELETE", path: "/api/v1/folders/{folder}", summary: "Delete a folder" },
  "api_index": { method: "GET", path: "/api/v1", summary: "API index with links to the docs" },
  "setup_instance": { method: "POST", path: "/api/v1/setup", summary: "First run: create the owner (bootstrap key only)" },
  "recover_owner_key": { method: "POST", path: "/api/v1/setup/recover", summary: "Mint a new owner key (bootstrap key only)" },
  "publish_upload": { method: "POST", path: "/api/v1/publish", summary: "Publish files in one call and get a live URL" },
  "create_version": { method: "POST", path: "/api/v1/sites/{slug}/versions", summary: "Start a version from a file manifest (upload only what is missing)" },
  "get_deploy": { method: "GET", path: "/api/v1/sites/{slug}/deploys/{id}", summary: "Pending version status (missing files)" },
  "upload_blob": { method: "PUT", path: "/api/v1/blobs/{sha256}", summary: "Upload one file's raw bytes" },
  "get_file_bytes": { method: "GET", path: "/api/v1/sites/{slug}/files/{path}", summary: "Read one file's raw bytes (ETag = sha256)" },
  "create_transfer": { method: "POST", path: "/api/v1/transfers", summary: "Create a file delivery" },
  "get_transfer": { method: "GET", path: "/api/v1/transfers/{transfer}", summary: "Read your file delivery" },
  "update_transfer": { method: "PATCH", path: "/api/v1/transfers/{transfer}", summary: "Edit an unnotified live delivery" },
  "revoke_transfers": { method: "POST", path: "/api/v1/transfers/revoke", summary: "Revoke file deliveries" },
  "list_operations": { method: "GET", path: "/api/v1/operations", summary: "List API operations and CLI commands" },
} as const;

export type OperationId = keyof typeof OPERATIONS;

export class DropwayClient extends DropwayHttpClient {
  /** Who am I */
  async whoami(input?: WhoamiInput, opts?: CallOptions): Promise<WhoamiOutput> {
    return this.call<WhoamiInput, WhoamiOutput>(OPERATIONS["whoami"], input ?? {}, opts);
  }
  /** Publish a site */
  async publishSite(input: PublishSiteInput, opts?: CallOptions): Promise<PublishSiteOutput> {
    return this.call<PublishSiteInput, PublishSiteOutput>(OPERATIONS["publish_site"], input, opts);
  }
  /** Change some files */
  async updateSiteFiles(input: UpdateSiteFilesInput, opts?: CallOptions): Promise<UpdateSiteFilesOutput> {
    return this.call<UpdateSiteFilesInput, UpdateSiteFilesOutput>(OPERATIONS["update_site_files"], input, opts);
  }
  /** Make an uploaded version live */
  async finalizeVersion(input: FinalizeVersionInput, opts?: CallOptions): Promise<FinalizeVersionOutput> {
    return this.call<FinalizeVersionInput, FinalizeVersionOutput>(OPERATIONS["finalize_version"], input, opts);
  }
  /** Get a site */
  async getSite(input: GetSiteInput, opts?: CallOptions): Promise<GetSiteOutput> {
    return this.call<GetSiteInput, GetSiteOutput>(OPERATIONS["get_site"], input, opts);
  }
  /** List sites */
  async listSites(input: ListSitesInput, opts?: CallOptions): Promise<ListSitesOutput> {
    return this.call<ListSitesInput, ListSitesOutput>(OPERATIONS["list_sites"], input, opts);
  }
  /** List files */
  async listFiles(input: ListFilesInput, opts?: CallOptions): Promise<ListFilesOutput> {
    return this.call<ListFilesInput, ListFilesOutput>(OPERATIONS["list_files"], input, opts);
  }
  /** Read a file */
  async readFile(input: ReadFileInput, opts?: CallOptions): Promise<ReadFileOutput> {
    return this.call<ReadFileInput, ReadFileOutput>(OPERATIONS["read_file"], input, opts);
  }
  /** List versions */
  async listVersions(input: ListVersionsInput, opts?: CallOptions): Promise<ListVersionsOutput> {
    return this.call<ListVersionsInput, ListVersionsOutput>(OPERATIONS["list_versions"], input, opts);
  }
  /** Restore version */
  async restoreVersion(input: RestoreVersionInput, opts?: CallOptions): Promise<RestoreVersionOutput> {
    return this.call<RestoreVersionInput, RestoreVersionOutput>(OPERATIONS["restore_version"], input, { ...opts, retry: "none" });
  }
  /** Change site settings */
  async updateSiteSettings(input: UpdateSiteSettingsInput, opts?: CallOptions): Promise<UpdateSiteSettingsOutput> {
    return this.call<UpdateSiteSettingsInput, UpdateSiteSettingsOutput>(OPERATIONS["update_site_settings"], input, opts);
  }
  /** Set who can open a site */
  async setSiteAccess(input: SetSiteAccessInput, opts?: CallOptions): Promise<SetSiteAccessOutput> {
    return this.call<SetSiteAccessInput, SetSiteAccessOutput>(OPERATIONS["set_site_access"], input, opts);
  }
  /** Delete a site */
  async deleteSite(input: DeleteSiteInput, opts?: CallOptions): Promise<DeleteSiteOutput> {
    return this.call<DeleteSiteInput, DeleteSiteOutput>(OPERATIONS["delete_site"], input, opts);
  }
  /** Claim an anonymous site */
  async claimSite(input: ClaimSiteInput, opts?: CallOptions): Promise<ClaimSiteOutput> {
    return this.call<ClaimSiteInput, ClaimSiteOutput>(OPERATIONS["claim_site"], input, opts);
  }
  /** Create an empty site */
  async createSite(input: CreateSiteInput, opts?: CallOptions): Promise<CreateSiteOutput> {
    return this.call<CreateSiteInput, CreateSiteOutput>(OPERATIONS["create_site"], input, opts);
  }
  /** Rename a site */
  async renameSite(input: RenameSiteInput, opts?: CallOptions): Promise<RenameSiteOutput> {
    return this.call<RenameSiteInput, RenameSiteOutput>(OPERATIONS["rename_site"], input, opts);
  }
  /** Duplicate a site's live version into a new slug */
  async duplicateSite(input: DuplicateSiteInput, opts?: CallOptions): Promise<DuplicateSiteOutput> {
    return this.call<DuplicateSiteInput, DuplicateSiteOutput>(OPERATIONS["duplicate_site"], input, opts);
  }
  /** Release a held site name early */
  async releaseSlug(input: ReleaseSlugInput, opts?: CallOptions): Promise<ReleaseSlugOutput> {
    return this.call<ReleaseSlugInput, ReleaseSlugOutput>(OPERATIONS["release_slug"], input, opts);
  }
  /** Get a version */
  async getVersion(input: GetVersionInput, opts?: CallOptions): Promise<GetVersionOutput> {
    return this.call<GetVersionInput, GetVersionOutput>(OPERATIONS["get_version"], input, opts);
  }
  /** Delete version */
  async deleteVersion(input: DeleteVersionInput, opts?: CallOptions): Promise<DeleteVersionOutput> {
    return this.call<DeleteVersionInput, DeleteVersionOutput>(OPERATIONS["delete_version"], input, { ...opts, retry: "none" });
  }
  /** Download a version as a ZIP */
  async exportVersion(input: ExportVersionInput, opts?: CallOptions): Promise<BytesResult> {
    return this.callBytes(OPERATIONS["export_version"], input, opts);
  }
  /** Start or resume a multipart upload */
  async createMultipartUpload(input: CreateMultipartUploadInput, opts?: CallOptions): Promise<CreateMultipartUploadOutput> {
    return this.call<CreateMultipartUploadInput, CreateMultipartUploadOutput>(OPERATIONS["create_multipart_upload"], input, opts);
  }
  /** Show a resumable upload's acknowledged parts */
  async getMultipartUpload(input: GetMultipartUploadInput, opts?: CallOptions): Promise<GetMultipartUploadOutput> {
    return this.call<GetMultipartUploadInput, GetMultipartUploadOutput>(OPERATIONS["get_multipart_upload"], input, opts);
  }
  /** Upload one part's raw bytes */
  async uploadMultipartPart(input: UploadMultipartPartInput, body: Uint8Array | ArrayBuffer | Blob | string, opts?: CallOptions): Promise<UploadMultipartPartOutput> {
    return this.callRaw<UploadMultipartPartInput, UploadMultipartPartOutput>(OPERATIONS["upload_multipart_part"], input, body, opts);
  }
  /** Complete and verify a resumable upload */
  async completeMultipartUpload(input: CompleteMultipartUploadInput, opts?: CallOptions): Promise<CompleteMultipartUploadOutput> {
    return this.call<CompleteMultipartUploadInput, CompleteMultipartUploadOutput>(OPERATIONS["complete_multipart_upload"], input, opts);
  }
  /** List API keys */
  async listApiKeys(input: ListApiKeysInput, opts?: CallOptions): Promise<ListApiKeysOutput> {
    return this.call<ListApiKeysInput, ListApiKeysOutput>(OPERATIONS["list_api_keys"], input, opts);
  }
  /** Create an API key */
  async createApiKey(input: CreateApiKeyInput, opts?: CallOptions): Promise<CreateApiKeyOutput> {
    return this.call<CreateApiKeyInput, CreateApiKeyOutput>(OPERATIONS["create_api_key"], input, opts);
  }
  /** Revoke an API key */
  async revokeApiKey(input: RevokeApiKeyInput, opts?: CallOptions): Promise<RevokeApiKeyOutput> {
    return this.call<RevokeApiKeyInput, RevokeApiKeyOutput>(OPERATIONS["revoke_api_key"], input, opts);
  }
  /** List members */
  async listMembers(input?: ListMembersInput, opts?: CallOptions): Promise<ListMembersOutput> {
    return this.call<ListMembersInput, ListMembersOutput>(OPERATIONS["list_members"], input ?? {}, opts);
  }
  /** Add a member */
  async addMember(input: AddMemberInput, opts?: CallOptions): Promise<AddMemberOutput> {
    return this.call<AddMemberInput, AddMemberOutput>(OPERATIONS["add_member"], input, opts);
  }
  /** Change a member */
  async updateMember(input: UpdateMemberInput, opts?: CallOptions): Promise<UpdateMemberOutput> {
    return this.call<UpdateMemberInput, UpdateMemberOutput>(OPERATIONS["update_member"], input, opts);
  }
  /** Remove a member */
  async removeMember(input: RemoveMemberInput, opts?: CallOptions): Promise<RemoveMemberOutput> {
    return this.call<RemoveMemberInput, RemoveMemberOutput>(OPERATIONS["remove_member"], input, opts);
  }
  /** Delete a folder */
  async deleteFolder(input: DeleteFolderInput, opts?: CallOptions): Promise<DeleteFolderOutput> {
    return this.call<DeleteFolderInput, DeleteFolderOutput>(OPERATIONS["delete_folder"], input, opts);
  }
  /** API index with links to the docs */
  async apiIndex(input?: ApiIndexInput, opts?: CallOptions): Promise<ApiIndexOutput> {
    return this.call<ApiIndexInput, ApiIndexOutput>(OPERATIONS["api_index"], input ?? {}, opts);
  }
  /** First run: create the owner (bootstrap key only) */
  async setupInstance(input: SetupInstanceInput, opts?: CallOptions): Promise<SetupInstanceOutput> {
    return this.call<SetupInstanceInput, SetupInstanceOutput>(OPERATIONS["setup_instance"], input, opts);
  }
  /** Mint a new owner key (bootstrap key only) */
  async recoverOwnerKey(input?: RecoverOwnerKeyInput, opts?: CallOptions): Promise<RecoverOwnerKeyOutput> {
    return this.call<RecoverOwnerKeyInput, RecoverOwnerKeyOutput>(OPERATIONS["recover_owner_key"], input ?? {}, opts);
  }
  /** Publish files in one call and get a live URL */
  async publishUpload(input: PublishUploadInput, opts?: CallOptions): Promise<PublishUploadOutput> {
    return this.call<PublishUploadInput, PublishUploadOutput>(OPERATIONS["publish_upload"], input, opts);
  }
  /** Start a version from a file manifest (upload only what is missing) */
  async createVersion(input: CreateVersionInput, opts?: CallOptions): Promise<CreateVersionOutput> {
    return this.call<CreateVersionInput, CreateVersionOutput>(OPERATIONS["create_version"], input, opts);
  }
  /** Pending version status (missing files) */
  async getDeploy(input: GetDeployInput, opts?: CallOptions): Promise<GetDeployOutput> {
    return this.call<GetDeployInput, GetDeployOutput>(OPERATIONS["get_deploy"], input, opts);
  }
  /** Upload one file's raw bytes */
  async uploadBlob(input: UploadBlobInput, body: Uint8Array | ArrayBuffer | Blob | string, opts?: CallOptions): Promise<UploadBlobOutput> {
    return this.callRaw<UploadBlobInput, UploadBlobOutput>(OPERATIONS["upload_blob"], input, body, opts);
  }
  /** Read one file's raw bytes (ETag = sha256) */
  async getFileBytes(input: GetFileBytesInput, opts?: CallOptions): Promise<BytesResult> {
    return this.callBytes(OPERATIONS["get_file_bytes"], input, opts);
  }
  /** Create a file delivery */
  async createTransfer(input: CreateTransferInput, opts?: CallOptions): Promise<CreateTransferOutput> {
    return this.call<CreateTransferInput, CreateTransferOutput>(OPERATIONS["create_transfer"], input, opts);
  }
  /** Read your file delivery */
  async getTransfer(input: GetTransferInput, opts?: CallOptions): Promise<GetTransferOutput> {
    return this.call<GetTransferInput, GetTransferOutput>(OPERATIONS["get_transfer"], input, opts);
  }
  /** Edit an unnotified live delivery */
  async updateTransfer(input: UpdateTransferInput, opts?: CallOptions): Promise<UpdateTransferOutput> {
    return this.call<UpdateTransferInput, UpdateTransferOutput>(OPERATIONS["update_transfer"], input, opts);
  }
  /** Revoke file deliveries */
  async revokeTransfers(input: RevokeTransfersInput, opts?: CallOptions): Promise<RevokeTransfersOutput> {
    return this.call<RevokeTransfersInput, RevokeTransfersOutput>(OPERATIONS["revoke_transfers"], input, opts);
  }
  /** List API operations and CLI commands */
  async listOperations(input?: ListOperationsInput, opts?: CallOptions): Promise<ListOperationsOutput> {
    return this.call<ListOperationsInput, ListOperationsOutput>(OPERATIONS["list_operations"], input ?? {}, opts);
  }
}
