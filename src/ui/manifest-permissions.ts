// The extension's Chrome permissions, for the build config, the worker, the pages and the checks.
//
// Browser features and local file access use optional permissions in the product: each adds an install warning the old Nanobrowser did not have, and
// Chrome turns an extension off after an update that adds a warning until the user accepts it. Each feature that uses
// one works with less until the user allows it with a click. The autorun build keeps them required, so the checks
// that save files or group tabs run without a click.

/** Tab group titles and colours, notifications, saving files, and Open on a saved file. */
export const OPTIONAL_PERMISSIONS = [
  'tabGroups',
  'notifications',
  'downloads',
  'downloads.open',
] as const satisfies readonly chrome.runtime.ManifestOptionalPermission[];

export const LOCAL_FILES_PERMISSION = 'nativeMessaging' as const;

export type OptionalPermission = (typeof OPTIONAL_PERMISSIONS)[number];

/** Always required. None of them adds a warning the old version did not have. */
export const REQUIRED_PERMISSIONS = [
  'debugger',
  'tabs',
  'sidePanel',
  'storage',
  'webNavigation',
  'unlimitedStorage',
  'alarms',
  'offscreen',
  'contextMenus',
  'scripting',
] as const satisfies readonly chrome.runtime.ManifestPermission[];

export interface PermissionLists {
  permissions: chrome.runtime.ManifestPermission[];
  optional_permissions: chrome.runtime.ManifestOptionalPermission[];
}

/** Native messaging is requested separately during local file setup. */
export function permissionLists(build: 'product' | 'autorun'): PermissionLists {
  return build === 'product'
    ? {
        permissions: [...REQUIRED_PERMISSIONS],
        optional_permissions: [...OPTIONAL_PERMISSIONS, LOCAL_FILES_PERMISSION],
      }
    : {
        permissions: [...REQUIRED_PERMISSIONS, ...OPTIONAL_PERMISSIONS, LOCAL_FILES_PERMISSION],
        optional_permissions: [],
      };
}
