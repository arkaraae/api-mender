export function removedConnectedRepositoryIds(
  connected: { id: string; github_repo_id: number | null }[],
  accessibleRepositoryIds: number[],
) {
  const allowed = new Set(accessibleRepositoryIds);
  return connected.filter(row => !allowed.has(row.github_repo_id ?? -1)).map(row => row.id);
}
