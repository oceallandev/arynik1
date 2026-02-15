from __future__ import annotations

from typing import Dict, Set

# Canonical roles used in the DB/JWT.
ROLE_ADMIN = "Admin"
ROLE_MANAGER = "Manager"
ROLE_DISPATCHER = "Dispatcher"
ROLE_WAREHOUSE = "Warehouse"
ROLE_DRIVER = "Driver"
ROLE_SUPPORT = "Support"
ROLE_FINANCE = "Finance"
ROLE_VIEWER = "Viewer"
ROLE_RECIPIENT = "Recipient"

VALID_ROLES: Set[str] = {
    ROLE_ADMIN,
    ROLE_MANAGER,
    ROLE_DISPATCHER,
    ROLE_WAREHOUSE,
    ROLE_DRIVER,
    ROLE_SUPPORT,
    ROLE_FINANCE,
    ROLE_VIEWER,
    ROLE_RECIPIENT,
}

# Permissions (used to gate API endpoints).
PERM_STATUS_OPTIONS_READ = "status-options:read"
PERM_STATS_READ = "stats:read"

PERM_SHIPMENTS_READ = "shipments:read"          # list shipments
PERM_SHIPMENT_READ = "shipment:read"            # single shipment by AWB
PERM_SHIPMENTS_ASSIGN = "shipments:assign"      # allocate/assign shipment to a driver/truck
PERM_LABEL_READ = "label:read"                  # label PDF

PERM_AWB_UPDATE = "awb:update"                  # update AWB status in Postis

PERM_LOGS_READ_SELF = "logs:read:self"
PERM_LOGS_READ_ALL = "logs:read:all"

PERM_NOTIFICATIONS_READ = "notifications:read"

PERM_CHAT_READ = "chat:read"
PERM_CHAT_WRITE = "chat:write"

PERM_DRIVERS_SYNC = "drivers:sync"
PERM_POSTIS_SYNC = "postis:sync"
PERM_USERS_READ = "users:read"
PERM_USERS_WRITE = "users:write"

# Role -> permissions
ROLE_PERMISSIONS: Dict[str, Set[str]] = {
    ROLE_ADMIN: {
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
        PERM_USERS_WRITE,
    },
    ROLE_MANAGER: {
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
        PERM_POSTIS_SYNC,
    },
    ROLE_DISPATCHER: {
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
        PERM_POSTIS_SYNC,
    },
    ROLE_WAREHOUSE: {
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
        PERM_POSTIS_SYNC,
    },
    ROLE_DRIVER: {
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
    },
    ROLE_SUPPORT: {
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
        PERM_POSTIS_SYNC,
    },
    ROLE_FINANCE: {
        PERM_STATUS_OPTIONS_READ,
        PERM_STATS_READ,
        PERM_SHIPMENTS_READ,
        PERM_SHIPMENT_READ,
        PERM_LOGS_READ_ALL,
        PERM_LOGS_READ_SELF,
        PERM_NOTIFICATIONS_READ,
        PERM_CHAT_READ,
        PERM_CHAT_WRITE,
    },
    ROLE_VIEWER: {
        PERM_STATUS_OPTIONS_READ,
        PERM_STATS_READ,
        PERM_SHIPMENTS_READ,
        PERM_SHIPMENT_READ,
        PERM_LABEL_READ,
        PERM_LOGS_READ_SELF,
        PERM_NOTIFICATIONS_READ,
        PERM_CHAT_READ,
        PERM_CHAT_WRITE,
    },
    ROLE_RECIPIENT: {
        PERM_SHIPMENTS_READ,
        PERM_SHIPMENT_READ,
        PERM_NOTIFICATIONS_READ,
        PERM_CHAT_READ,
        PERM_CHAT_WRITE,
    },
}

# Common Romanian/English aliases -> canonical role.
_ROLE_ALIASES: Dict[str, str] = {
    "ADMIN": ROLE_ADMIN,
    "ADMINISTRATOR": ROLE_ADMIN,
    "MANAGER": ROLE_MANAGER,
    "DISPATCHER": ROLE_DISPATCHER,
    "DISPECER": ROLE_DISPATCHER,
    "WAREHOUSE": ROLE_WAREHOUSE,
    "DEPOZIT": ROLE_WAREHOUSE,
    "DRIVER": ROLE_DRIVER,
    "CURIER": ROLE_DRIVER,
    "SOFER": ROLE_DRIVER,
    "ȘOFER": ROLE_DRIVER,
    "SUPPORT": ROLE_SUPPORT,
    "SUPORT": ROLE_SUPPORT,
    "FINANCE": ROLE_FINANCE,
    "FINANCIAR": ROLE_FINANCE,
    "VIEWER": ROLE_VIEWER,
    "VIZUALIZATOR": ROLE_VIEWER,
    "RECIPIENT": ROLE_RECIPIENT,
    "CUSTOMER": ROLE_RECIPIENT,
    "CLIENT": ROLE_RECIPIENT,
}


def normalize_role(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return raw

    key = raw.upper()
    alias = _ROLE_ALIASES.get(key)
    if alias:
        return alias

    # If it matches a valid role case-insensitively, return canonical.
    for role in VALID_ROLES:
        if role.upper() == key:
            return role

    return raw


def role_has_permission(role: str, permission: str) -> bool:
    role_norm = normalize_role(role)
    perms = ROLE_PERMISSIONS.get(role_norm, set())
    if permission in perms:
        return True

    # Implicit: "all logs" includes "self logs".
    if permission == PERM_LOGS_READ_SELF and PERM_LOGS_READ_ALL in perms:
        return True

    return False


def can_view_all_logs(role: str) -> bool:
    return role_has_permission(role, PERM_LOGS_READ_ALL)
