export function resolveLinuxSandbox({ helperPath, helperIsRootSetuid, userNamespacesRestricted }) {
  if (helperIsRootSetuid) return { ok: true, arguments: [] };
  if (!userNamespacesRestricted) {
    return { ok: true, arguments: ['--disable-setuid-sandbox'] };
  }
  return {
    ok: false,
    message: `DagentWork cannot start securely because this Linux host restricts unprivileged user namespaces and ${helperPath} is not a root-owned setuid sandbox helper. Configure that file with owner root and mode 4755, or install a system package that provides an AppArmor user-namespace profile. DagentWork will not fall back to --no-sandbox.`,
  };
}
