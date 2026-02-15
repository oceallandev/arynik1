// Frontend RBAC mirrors backend/authz.py so the UI can gate pages/actions.

export const ROLE_ADMIN = 'Admin';
export const ROLE_MANAGER = 'Manager';
export const ROLE_DISPATCHER = 'Dispatcher';
export const ROLE_WAREHOUSE = 'Warehouse';
export const ROLE_DRIVER = 'Driver';
export const ROLE_SUPPORT = 'Support';
export const ROLE_FINANCE = 'Finance';
export const ROLE_VIEWER = 'Viewer';
export const ROLE_RECIPIENT = 'Recipient';

export const VALID_ROLES = [
  ROLE_ADMIN,
  ROLE_MANAGER,
  ROLE_DISPATCHER,
  ROLE_WAREHOUSE,
  ROLE_DRIVER,
  ROLE_SUPPORT,
  ROLE_FINANCE,
  ROLE_VIEWER,
  ROLE_RECIPIENT
];

// Permissions (used to gate API endpoints).
export const PERM_STATUS_OPTIONS_READ = 'status-options:read';
export const PERM_STATS_READ = 'stats:read';

export const PERM_SHIPMENTS_READ = 'shipments:read';
export const PERM_SHIPMENT_READ = 'shipment:read';
export const PERM_SHIPMENTS_ASSIGN = 'shipments:assign';
export const PERM_LABEL_READ = 'label:read';

export const PERM_AWB_UPDATE = 'awb:update';

export const PERM_LOGS_READ_SELF = 'logs:read:self';
export const PERM_LOGS_READ_ALL = 'logs:read:all';

export const PERM_NOTIFICATIONS_READ = 'notifications:read';

export const PERM_CHAT_READ = 'chat:read';
export const PERM_CHAT_WRITE = 'chat:write';

export const PERM_DRIVERS_SYNC = 'drivers:sync';
export const PERM_POSTIS_SYNC = 'postis:sync';
export const PERM_USERS_READ = 'users:read';
export const PERM_USERS_WRITE = 'users:write';

// Role -> permissions
// Keep in sync with backend/authz.py.
export const ROLE_PERMISSIONS = {
  [ROLE_ADMIN]: new Set([
    PERM_STATUS_OPTIONS_READ,
    PERM_STATS_READ,
    PERM_SHIPMENTS_READ,
    PERM_SHIPMENT_READ,
    PERM_SHIPMENTS_ASSIGN,
    PERM_LABEL_READ,
    PERM_AWB_UPDATE,
    PERM_LOGS_READ_ALL,
    PERM_LOGS_READ_SELF,
    PERM_NOTIFICATIONS_READ,
    PERM_CHAT_READ,
    PERM_CHAT_WRITE,
    PERM_DRIVERS_SYNC,
    PERM_POSTIS_SYNC,
    PERM_USERS_READ,
    PERM_USERS_WRITE
  ]),
  [ROLE_MANAGER]: new Set([
    PERM_STATUS_OPTIONS_READ,
    PERM_STATS_READ,
    PERM_SHIPMENTS_READ,
    PERM_SHIPMENT_READ,
    PERM_SHIPMENTS_ASSIGN,
    PERM_LABEL_READ,
    PERM_AWB_UPDATE,
    PERM_LOGS_READ_ALL,
    PERM_LOGS_READ_SELF,
    PERM_NOTIFICATIONS_READ,
    PERM_CHAT_READ,
    PERM_CHAT_WRITE,
    PERM_USERS_READ,
    PERM_POSTIS_SYNC
  ]),
  [ROLE_DISPATCHER]: new Set([
    PERM_STATUS_OPTIONS_READ,
    PERM_STATS_READ,
    PERM_SHIPMENTS_READ,
    PERM_SHIPMENT_READ,
    PERM_SHIPMENTS_ASSIGN,
    PERM_LABEL_READ,
    PERM_AWB_UPDATE,
    PERM_LOGS_READ_ALL,
    PERM_LOGS_READ_SELF,
    PERM_NOTIFICATIONS_READ,
    PERM_CHAT_READ,
    PERM_CHAT_WRITE,
    PERM_USERS_READ,
    PERM_POSTIS_SYNC
  ]),
  [ROLE_WAREHOUSE]: new Set([
    PERM_STATUS_OPTIONS_READ,
    PERM_STATS_READ,
    PERM_SHIPMENTS_READ,
    PERM_SHIPMENT_READ,
    PERM_SHIPMENTS_ASSIGN,
    PERM_LABEL_READ,
    PERM_AWB_UPDATE,
    PERM_LOGS_READ_SELF,
    PERM_NOTIFICATIONS_READ,
    PERM_CHAT_READ,
    PERM_CHAT_WRITE,
    PERM_POSTIS_SYNC
  ]),
  [ROLE_DRIVER]: new Set([
    PERM_STATUS_OPTIONS_READ,
    PERM_STATS_READ,
    PERM_SHIPMENTS_READ,
    PERM_SHIPMENT_READ,
    PERM_LABEL_READ,
    PERM_AWB_UPDATE,
    PERM_LOGS_READ_SELF,
    PERM_NOTIFICATIONS_READ,
    PERM_CHAT_READ,
    PERM_CHAT_WRITE,
    PERM_POSTIS_SYNC
  ]),
  [ROLE_SUPPORT]: new Set([
    PERM_STATUS_OPTIONS_READ,
    PERM_STATS_READ,
    PERM_SHIPMENTS_READ,
    PERM_SHIPMENT_READ,
    PERM_LABEL_READ,
    PERM_LOGS_READ_ALL,
    PERM_LOGS_READ_SELF,
    PERM_NOTIFICATIONS_READ,
    PERM_CHAT_READ,
    PERM_CHAT_WRITE
  ]),
  [ROLE_FINANCE]: new Set([
    PERM_STATUS_OPTIONS_READ,
    PERM_STATS_READ,
    PERM_SHIPMENTS_READ,
    PERM_SHIPMENT_READ,
    PERM_LOGS_READ_ALL,
    PERM_LOGS_READ_SELF,
    PERM_NOTIFICATIONS_READ,
    PERM_CHAT_READ,
    PERM_CHAT_WRITE
  ]),
  [ROLE_VIEWER]: new Set([
    PERM_STATUS_OPTIONS_READ,
    PERM_STATS_READ,
    PERM_SHIPMENTS_READ,
    PERM_SHIPMENT_READ,
    PERM_LABEL_READ,
    PERM_LOGS_READ_SELF,
    PERM_NOTIFICATIONS_READ,
    PERM_CHAT_READ,
    PERM_CHAT_WRITE
  ]),
  [ROLE_RECIPIENT]: new Set([
    PERM_SHIPMENTS_READ,
    PERM_SHIPMENT_READ,
    PERM_NOTIFICATIONS_READ,
    PERM_CHAT_READ,
    PERM_CHAT_WRITE
  ])
};

export const normalizeRole = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return raw;

  // Most roles are already canonical; keep a small safety net for casing.
  const upper = raw.toUpperCase();
  for (const role of VALID_ROLES) {
    if (role.toUpperCase() === upper) return role;
  }

  return raw;
};

export const permissionsForRole = (role) => {
  const norm = normalizeRole(role);
  const perms = ROLE_PERMISSIONS[norm];
  if (!perms) return [];
  return Array.from(perms).sort();
};
