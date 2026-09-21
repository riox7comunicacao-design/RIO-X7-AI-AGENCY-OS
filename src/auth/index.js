const { ACTION, ROLE, USER_STATUS, PERMISSION, ROLE_PERMISSION_TEMPLATE, isValidPermissionString } = require('./constants');
const { defineUser } = require('./user');
const {
  assertIsAuthorizationContext,
  requireActiveUser,
  hasPermission,
  requirePermission,
} = require('./authorizationContext');
const {
  createUserStore,
  resolveAuthorizationContext,
  UserResolutionError,
  USER_RESOLUTION_ERROR,
  USER_NOT_FOUND,
} = require('./userResolver');
const {
  SUPABASE_ENV_VARS,
  isSupabaseConfigured,
  createSupabaseAuthAdapter,
  SupabaseAdapterError,
  CONNECTIVITY_ERROR,
} = require('./authAdapter');
const { authorizeReviewerForApprovalQueue, toApprovalQueueIdentity } = require('./approvalQueueBridge');

// Fase C: createAuthorizationContext e o emissor de contexto NÃO são exportados.
// O emissor é interno (internal/contextIssuer.js) e só o userResolver o usa; o
// barrel público só oferece as VERIFICAÇÕES de contexto abaixo.
module.exports = {
  ACTION,
  ROLE,
  USER_STATUS,
  PERMISSION,
  ROLE_PERMISSION_TEMPLATE,
  isValidPermissionString,
  defineUser,
  assertIsAuthorizationContext,
  requireActiveUser,
  hasPermission,
  requirePermission,
  createUserStore,
  resolveAuthorizationContext,
  UserResolutionError,
  USER_RESOLUTION_ERROR,
  USER_NOT_FOUND,
  SUPABASE_ENV_VARS,
  isSupabaseConfigured,
  createSupabaseAuthAdapter,
  SupabaseAdapterError,
  CONNECTIVITY_ERROR,
  authorizeReviewerForApprovalQueue,
  toApprovalQueueIdentity,
};
