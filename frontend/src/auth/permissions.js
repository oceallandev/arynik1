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

export const PERM_POD_READ = 'pod:read';
export const PERM_POD_WRITE = 'pod:write';

export const PERM_COD_READ = 'cod:read';
export const PERM_COD_WRITE = 'cod:write';

export const PERM_MANIFESTS_READ = 'manifests:read';
export const PERM_MANIFESTS_WRITE = 'manifests:write';

export const PERM_CONTACTS_WRITE = 'contacts:write';

export const PERM_ROUTE_RUNS_READ = 'route-runs:read';
export const PERM_ROUTE_RUNS_WRITE = 'route-runs:write';

export const PERM_LIVEOPS_READ = 'liveops:read';

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
    PERM_POD_READ,
    PERM_POD_WRITE,
    PERM_COD_READ,
    PERM_COD_WRITE,
    PERM_MANIFESTS_READ,
    PERM_MANIFESTS_WRITE,
    PERM_CONTACTS_WRITE,
    PERM_ROUTE_RUNS_READ,
    PERM_ROUTE_RUNS_WRITE,
    PERM_LIVEOPS_READ,
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
    PERM_POD_READ,
    PERM_POD_WRITE,
    PERM_COD_READ,
    PERM_COD_WRITE,
    PERM_MANIFESTS_READ,
    PERM_MANIFESTS_WRITE,
    PERM_CONTACTS_WRITE,
    PERM_ROUTE_RUNS_READ,
    PERM_ROUTE_RUNS_WRITE,
    PERM_LIVEOPS_READ,
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
    PERM_POD_READ,
    PERM_POD_WRITE,
    PERM_COD_READ,
    PERM_COD_WRITE,
    PERM_MANIFESTS_READ,
    PERM_MANIFESTS_WRITE,
    PERM_CONTACTS_WRITE,
    PERM_ROUTE_RUNS_READ,
    PERM_ROUTE_RUNS_WRITE,
    PERM_LIVEOPS_READ,
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
    PERM_POD_READ,
    PERM_POD_WRITE,
    PERM_COD_READ,
    PERM_COD_WRITE,
    PERM_MANIFESTS_READ,
    PERM_MANIFESTS_WRITE,
    PERM_CONTACTS_WRITE,
    PERM_ROUTE_RUNS_READ,
    PERM_ROUTE_RUNS_WRITE,
    PERM_LIVEOPS_READ,
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
    PERM_POD_READ,
    PERM_POD_WRITE,
    PERM_COD_READ,
    PERM_COD_WRITE,
    PERM_MANIFESTS_READ,
    PERM_MANIFESTS_WRITE,
    PERM_CONTACTS_WRITE,
    PERM_ROUTE_RUNS_WRITE,
    PERM_LIVEOPS_READ,
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
    PERM_CHAT_WRITE,
    PERM_POD_READ,
    PERM_COD_READ,
    PERM_MANIFESTS_READ,
    PERM_CONTACTS_WRITE,
    PERM_ROUTE_RUNS_READ,
    PERM_LIVEOPS_READ,
    PERM_POSTIS_SYNC
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
    PERM_CHAT_WRITE,
    PERM_COD_READ,
    PERM_COD_WRITE,
    PERM_POD_READ,
    PERM_ROUTE_RUNS_READ,
    PERM_LIVEOPS_READ
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
    PERM_CHAT_WRITE,
    PERM_POD_READ,
    PERM_COD_READ,
    PERM_MANIFESTS_READ,
    PERM_ROUTE_RUNS_READ,
    PERM_LIVEOPS_READ
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

  // Keep a small alias map in sync with backend/authz.py so older tokens / custom DB values
  // still get proper UI permissions.
  const upper = raw.toUpperCase();
  const aliases = {
    ADMIN: ROLE_ADMIN,
    ADMINISTRATOR: ROLE_ADMIN,
    MANAGER: ROLE_MANAGER,
    DISPATCHER: ROLE_DISPATCHER,
    DISPECER: ROLE_DISPATCHER,
    WAREHOUSE: ROLE_WAREHOUSE,
    DEPOZIT: ROLE_WAREHOUSE,
    DRIVER: ROLE_DRIVER,
    CURIER: ROLE_DRIVER,
    SOFER: ROLE_DRIVER,
    'ȘOFER': ROLE_DRIVER,
    SUPPORT: ROLE_SUPPORT,
    SUPORT: ROLE_SUPPORT,
    FINANCE: ROLE_FINANCE,
    FINANCIAR: ROLE_FINANCE,
    VIEWER: ROLE_VIEWER,
    VIZUALIZATOR: ROLE_VIEWER,
    RECIPIENT: ROLE_RECIPIENT,
    CUSTOMER: ROLE_RECIPIENT,
    CLIENT: ROLE_RECIPIENT
  };
  if (aliases[upper]) return aliases[upper];

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
