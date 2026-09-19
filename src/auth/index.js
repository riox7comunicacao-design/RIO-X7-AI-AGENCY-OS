const { ACTION, ROLE, USER_STATUS, PERMISSION, ROLE_PERMISSION_TEMPLATE, isValidPermissionString } = require('./constants');
const { defineUser } = require('./user');
const {
  createAuthorizationContext,
  assertIsAuthorizationContext,
  requireActiveUser,
  hasPermission,
  requirePermission,
} = require('./authorizationContext');
const { createUserStore, resolveAuthorizationContext } = require('./userResolver');
const {
  SUPABASE_ENV_VARS,
  isSupabaseConfigured,
  createSupabaseAuthAdapter,
  SupabaseAdapterError,
  CONNECTIVITY_ERROR,
} = require('./authAdapter');
const { toApprovalQueueIdentity } = require('./approvalQueueBridge');

module.exports = {
  ACTION,
  ROLE,
  USER_STATUS,
  PERMISSION,
  ROLE_PERMISSION_TEMPLATE,
  isValidPermissionString,
  defineUser,
  createAuthorizationContext,
  assertIsAuthorizationContext,
  requireActiveUser,
  hasPermission,
  requirePermission,
  createUserStore,
  resolveAuthorizationContext,
  SUPABASE_ENV_VARS,
  isSupabaseConfigured,
  createSupabaseAuthAdapter,
  SupabaseAdapterError,
  CONNECTIVITY_ERROR,
  toApprovalQueueIdentity,
};
