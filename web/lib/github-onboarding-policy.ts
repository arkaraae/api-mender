export type VerifiedInstallation = {
  id: number;
  app_id: number;
  account?: { login?: string };
  suspended_at?: string | null;
};

export type AccessibleRepository = {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
  archived?: boolean;
};

export function matchingInstallation(items: VerifiedInstallation[], requestedId: number, appId: string) {
  return items.find(item => item.id === requestedId && String(item.app_id) === appId
    && !!item.account?.login && !item.suspended_at);
}

export function validAccessibleRepositories(repositories: AccessibleRepository[], totalCount: number) {
  if (totalCount < 1 || totalCount > 25 || repositories.length !== totalCount) return false;
  return repositories.every(repo => Number.isSafeInteger(repo.id) && repo.id > 0
    && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/.test(repo.full_name)
    && repo.full_name.split('/').every(segment => segment !== '.' && segment !== '..')
    && typeof repo.default_branch === 'string' && repo.default_branch.length > 0
    && repo.default_branch.length <= 120 && typeof repo.private === 'boolean');
}
