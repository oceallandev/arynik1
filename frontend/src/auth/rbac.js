import { PERM_LOGS_READ_ALL, PERM_LOGS_READ_SELF, permissionsForRole } from './permissions';

const toSet = (value) => {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.filter(Boolean));
  return new Set();
};

export const permissionsForUser = (user) => {
  const explicit = toSet(user?.permissions);
  if (explicit.size > 0) {
    // Mirror backend's implicit rule: "all logs" includes "self logs".
    if (explicit.has(PERM_LOGS_READ_ALL)) explicit.add(PERM_LOGS_READ_SELF);
    return explicit;
  }

  const fallback = toSet(permissionsForRole(user?.role));
  if (fallback.has(PERM_LOGS_READ_ALL)) fallback.add(PERM_LOGS_READ_SELF);
  return fallback;
};

export const hasPermission = (user, permission) => {
  if (!permission) return true;
  return permissionsForUser(user).has(permission);
};

export const hasAllPermissions = (user, permissions = []) => {
  const required = Array.isArray(permissions) ? permissions.filter(Boolean) : [];
  if (required.length === 0) return true;
  const perms = permissionsForUser(user);
  return required.every((p) => perms.has(p));
};

